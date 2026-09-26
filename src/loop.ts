import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { Rejected, type Attempt, type Manager, type Task } from './manager.ts';
import type { HistoryEntry } from './report.ts';

// 실행 루프. tick 마다 ① 재조회·멈춤 알림 ② 검증 ③ 총괄 호출과 제안 적용을 한다.
// 상태는 모두 Manager(SQLite)에 있으므로 루프 프로세스가 죽어도 다시 띄우면 이어서 돈다.

export type Proposal =
  // prompt 를 주면 저장된 프롬프트 대신 쓴다. 선행 작업의 결과를 옮겨 담을 때 쓴다
  | { kind: 'dispatch'; taskId: string; expectedVersion: number; prompt?: string }
  | { kind: 'add_task'; id: string; prompt: string; dependsOn: string[]; blockedBy?: string }
  | { kind: 'ask_user'; decisionId: string; question: string };

// goalComplete: 총괄이 목표 달성 여부를 판단할 때만 채운다. 비워 두면 "모든 작업 done" 이 곧 완료다
export type Plan = { proposals: Proposal[]; goalComplete?: boolean; reasoning?: string };

export type Snapshot = {
  goal: string;
  tasks: Task[];
  runnable: string[];
  capacity: number;
  attempts: Record<string, number>;
  decisions: ReturnType<Manager['decisions']>;
  history: HistoryEntry[];
};

export interface Coordinator {
  // true 면 모든 작업이 done 이어도 총괄이 goalComplete 를 줘야 루프가 끝난다
  readonly decidesCompletion?: boolean;
  propose(s: Snapshot): Plan | Promise<Plan>;
}

export type IntegrationResult = { passed: boolean; sha: string };
export type Integrator = (task: Task, attempt: Attempt) => Promise<IntegrationResult>;

// 실행 가능한 작업을 추가된 순서대로 제안한다
export const inOrderCoordinator: Coordinator = {
  propose({ tasks, runnable, capacity }) {
    return {
      proposals: runnable.slice(0, capacity).map((id) => ({
        kind: 'dispatch' as const, taskId: id, expectedVersion: tasks.find((x) => x.id === id)!.version,
      })),
    };
  },
};

// 작업자의 작업 디렉터리에서 검증 명령을 돌려 종료 코드로 판정한다. 프로젝트와 병합하지는 않는다
export function commandIntegrator(command: string): Integrator {
  return async (_task, attempt) => {
    let passed = true;
    try {
      execFileSync('sh', ['-c', command], { cwd: attempt.workdir, stdio: 'ignore' });
    } catch {
      passed = false;
    }
    let sha = 'no-git';
    try {
      sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: attempt.workdir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch { /* git 저장소가 아니면 SHA 없이 기록한다 */ }
    return { passed, sha };
  };
}

export type LoopOptions = {
  coordinator?: Coordinator;
  integrator: Integrator;
  maxConcurrent: number;
  intervalMs: number;
  signal?: AbortSignal;
  maxTicks?: number;
  // 매 tick 끝에 부른다. CLI 는 여기서 STATUS.md 를 갱신한다
  onTick?: (m: Manager) => void;
};

export type LoopResult = { status: 'done' | 'stopped' | 'max_ticks'; ticks: number };

// 총괄 제안 검증 상한
const MAX_NEW_TASKS_PER_PLAN = 10;
const MAX_TASKS = 50;
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
// 총괄 호출이 이만큼 연속 실패하면 멈춤으로 알린다
const COORDINATOR_FAILURE_ALERT = 3;

export async function tick(m: Manager, opts: LoopOptions): Promise<void> {
  await m.recover();

  for (const t of m.tasks().filter((x) => x.state === 'integrating')) {
    const a = m.lastSucceeded(t.id);
    if (!a) continue;
    const r = await opts.integrator(t, a);
    m.integrate(t.id, r.sha, r.passed);
  }

  await consult(m, opts);
  // 새로 생긴 멈춤(시도 상한, 총괄 실패 등)은 제안을 적용한 뒤에도 확인한다
  m.alertIfNeeded();
}

// 상태가 바뀌었을 때만 총괄을 부른다. LLM 총괄은 부를 때마다 비용이 들기 때문이다
async function consult(m: Manager, opts: LoopOptions): Promise<void> {
  const coordinator = opts.coordinator ?? inOrderCoordinator;
  const capacity = opts.maxConcurrent - m.liveCount();
  const seq = m.stateSeq();
  if (String(seq) === m.meta('coordinator_seq') || capacity <= 0) return;

  let plan: Plan;
  try {
    plan = await coordinator.propose({
      goal: m.goal(), tasks: m.tasks(), runnable: m.runnable(), capacity,
      attempts: m.attemptCounts(), decisions: m.decisions(), history: m.history(30),
    });
    if (!plan || !Array.isArray(plan.proposals)) throw new Error('제안 형식이 아니다');
  } catch (e) {
    coordinatorFailed(m, e);
    return;
  }
  m.noteCoordinator('coordinator_called',
    `제안 ${plan.proposals.length}개, goal_complete ${plan.goalComplete ?? '-'}${plan.reasoning ? `: ${plan.reasoning.slice(0, 160)}` : ''}`);
  const failures = Number(m.meta('coordinator_failures') ?? 0);
  if (failures) {
    m.clearFlag(`coordinator_failed:${m.meta('coordinator_fail_since')}`);
    m.setMeta('coordinator_failures', '0');
  }

  const changed = await applyPlan(m, plan, capacity);
  m.setMeta('goal_complete', plan.goalComplete === true ? '1' : '0');
  // 모든 작업이 끝났는데 총괄이 목표 미완료라 하면서 다음 작업을 내지 않으면 루프가 할 일이 없다. 알린다
  const done = m.tasks().length > 0 && m.tasks().every((t) => t.state === 'done');
  m.clearFlagPrefix('coordinator_idle:');
  if (coordinator.decidesCompletion && done && plan.goalComplete !== true) {
    m.setFlag(`coordinator_idle:${seq}`, null, '총괄이 목표가 끝나지 않았다고 했지만 다음 작업을 내지 않았다',
      'goal 을 더 구체적으로 고치거나(loop-ai goal) 필요한 작업을 직접 추가한다(loop-ai add)');
  }
  // 작업이나 결정을 새로 만들었으면 다음 tick 에 다시 불러 그 작업을 dispatch 하게 한다.
  // 그 밖에는 제안을 적용하며 생긴 히스토리로 다시 부르지 않도록 적용 뒤의 번호를 기록한다
  m.setMeta('coordinator_seq', String(changed ? seq : m.stateSeq()));
}

function coordinatorFailed(m: Manager, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  const n = Number(m.meta('coordinator_failures') ?? 0) + 1;
  if (n === 1) m.setMeta('coordinator_fail_since', String(m.stateSeq()));
  m.setMeta('coordinator_failures', String(n));
  m.noteCoordinator('coordinator_failed', `총괄 호출 실패 ${n}회째: ${msg.slice(0, 200)}`);
  if (n >= COORDINATOR_FAILURE_ALERT) {
    m.setFlag(`coordinator_failed:${m.meta('coordinator_fail_since')}`, null, `총괄 호출이 ${n}번 연속 실패했다: ${msg.slice(0, 200)}`,
      '총괄 CLI 가 로그인돼 있는지, 네트워크와 사용량 한도를 확인한다. 루프는 다음 tick 에 다시 부른다');
  }
  // 실패한 뒤에도 다음 tick 에 다시 부르도록 coordinator_seq 는 갱신하지 않는다
}

// 총괄의 제안을 하나씩 검증해 적용한다. 거절한 것은 이유와 함께 히스토리에 남긴다
// 작업이나 결정을 새로 만들었으면 true
async function applyPlan(m: Manager, plan: Plan, capacity: number): Promise<boolean> {
  let added = 0;
  let asked = 0;
  let dispatched = 0;
  for (const p of plan.proposals) {
    try {
      if (p.kind === 'add_task') {
        if (!ID.test(p.id)) throw new Rejected(`작업 ID 형식이 아니다: ${p.id}`);
        if (m.tasks().some((t) => t.id === p.id)) throw new Rejected(`이미 있는 작업: ${p.id}`);
        if (added >= MAX_NEW_TASKS_PER_PLAN) throw new Rejected(`한 번에 추가할 수 있는 작업은 ${MAX_NEW_TASKS_PER_PLAN}개다`);
        if (m.tasks().length >= MAX_TASKS) throw new Rejected(`작업은 모두 ${MAX_TASKS}개까지다`);
        if (!p.prompt?.trim()) throw new Rejected(`프롬프트가 비었다: ${p.id}`);
        // 선행 작업은 이미 있어야 한다. 그러면 순환이 생길 수 없다
        for (const d of p.dependsOn ?? []) {
          if (!m.tasks().some((t) => t.id === d)) throw new Rejected(`없는 선행 작업: ${d}`);
        }
        if (p.blockedBy && !m.hasDecision(p.blockedBy)) throw new Rejected(`없는 결정: ${p.blockedBy}`);
        m.addTask(p.id, { prompt: p.prompt, dependsOn: p.dependsOn ?? [], blockedBy: p.blockedBy });
        added++;
      } else if (p.kind === 'ask_user') {
        if (!ID.test(p.decisionId)) throw new Rejected(`결정 ID 형식이 아니다: ${p.decisionId}`);
        if (m.hasDecision(p.decisionId)) throw new Rejected(`이미 있는 결정: ${p.decisionId}`);
        if (asked >= 1) throw new Rejected('사용자 질문은 한 번에 하나만 한다');
        if (!p.question?.trim()) throw new Rejected('질문이 비었다');
        m.openDecision(p.decisionId, p.question);
        asked++;
      } else if (p.kind === 'dispatch') {
        if (dispatched >= capacity) throw new Rejected(`동시 실행 상한을 넘는 제안: ${p.taskId}`);
        const t = m.task(p.taskId);
        // 버전·상태·선행 작업·시도 상한 검증은 dispatch 가 한다
        await m.dispatch(t.id, p.expectedVersion, p.prompt?.trim() ? p.prompt : t.prompt);
        dispatched++;
      } else {
        throw new Rejected(`모르는 제안 종류: ${(p as { kind?: string }).kind}`);
      }
    } catch (e) {
      if (!(e instanceof Rejected)) throw e;
      m.noteRejected((p as { taskId?: string; id?: string }).taskId ?? (p as { id?: string }).id ?? '-', e.message);
    }
  }
  return added + asked > 0;
}

export async function runLoop(m: Manager, opts: LoopOptions): Promise<LoopResult> {
  const coordinator = opts.coordinator ?? inOrderCoordinator;
  let ticks = 0;
  while (true) {
    if (opts.signal?.aborted) return { status: 'stopped', ticks };
    await tick(m, opts);
    ticks++;
    opts.onTick?.(m);
    const tasks = m.tasks();
    const allDone = tasks.length > 0 && tasks.every((t) => t.state === 'done');
    if (allDone && (!coordinator.decidesCompletion || m.meta('goal_complete') === '1')) return { status: 'done', ticks };
    if (opts.maxTicks !== undefined && ticks >= opts.maxTicks) return { status: 'max_ticks', ticks };
    // 멈춘 작업만 남아도 끝내지 않는다. 사용자 응답·판정이 들어오면 다음 tick 에서 이어 간다
    try {
      await sleep(opts.intervalMs, undefined, { signal: opts.signal });
    } catch {
      return { status: 'stopped', ticks };
    }
  }
}
