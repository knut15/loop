import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { Rejected, type Attempt, type Manager, type Task } from './manager.ts';

// 실행 루프. tick 마다 ① 재조회·멈춤 알림 ② 통합 검증 ③ 동시 실행 상한 안에서 dispatch 를 한다.
// 상태는 모두 Manager(SQLite)에 있으므로 루프 프로세스가 죽어도 다시 띄우면 이어서 돈다.

export type Proposal = { taskId: string; expectedVersion: number; prompt: string };
export type Snapshot = { tasks: Task[]; runnable: string[]; capacity: number };

// 총괄. 지금은 규칙 기반 기본 구현만 있다. LLM 총괄도 이 인터페이스로 갈아 끼운다
export interface Coordinator {
  propose(s: Snapshot): Proposal[] | Promise<Proposal[]>;
}

export type IntegrationResult = { passed: boolean; sha: string };
export type Integrator = (task: Task, attempt: Attempt) => Promise<IntegrationResult>;

// 실행 가능한 작업을 추가된 순서대로 제안한다
export const inOrderCoordinator: Coordinator = {
  propose({ tasks, runnable, capacity }) {
    return runnable.slice(0, capacity).map((id) => {
      const t = tasks.find((x) => x.id === id)!;
      return { taskId: id, expectedVersion: t.version, prompt: t.prompt };
    });
  },
};

// 작업자의 작업 디렉터리에서 검증 명령을 돌려 종료 코드로 판정한다
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

export async function tick(m: Manager, opts: LoopOptions): Promise<void> {
  await m.recover();

  for (const t of m.tasks().filter((x) => x.state === 'integrating')) {
    const a = m.lastSucceeded(t.id);
    if (!a) continue;
    const r = await opts.integrator(t, a);
    m.integrate(t.id, r.sha, r.passed);
  }

  const capacity = opts.maxConcurrent - m.liveCount();
  if (capacity > 0) {
    const coordinator = opts.coordinator ?? inOrderCoordinator;
    const proposals = await coordinator.propose({ tasks: m.tasks(), runnable: m.runnable(), capacity });
    // 총괄이 상한보다 많이 제안해도 상한까지만 실행한다
    for (const p of proposals.slice(0, capacity)) {
      try {
        await m.dispatch(p.taskId, p.expectedVersion, p.prompt);
      } catch (e) {
        if (!(e instanceof Rejected)) throw e;
        m.noteRejected(p.taskId, e.message);
      }
    }
  }
  // 새로 생긴 멈춤(시도 상한 등)은 dispatch 뒤에도 확인한다
  m.alertIfNeeded();
}

export async function runLoop(m: Manager, opts: LoopOptions): Promise<LoopResult> {
  let ticks = 0;
  while (true) {
    if (opts.signal?.aborted) return { status: 'stopped', ticks };
    await tick(m, opts);
    ticks++;
    opts.onTick?.(m);
    const tasks = m.tasks();
    if (tasks.length > 0 && tasks.every((t) => t.state === 'done')) return { status: 'done', ticks };
    if (opts.maxTicks !== undefined && ticks >= opts.maxTicks) return { status: 'max_ticks', ticks };
    // 멈춘 작업만 남아도 끝내지 않는다. 사용자 응답·판정이 들어오면 다음 tick 에서 이어 간다
    try {
      await sleep(opts.intervalMs, undefined, { signal: opts.signal });
    } catch {
      return { status: 'stopped', ticks };
    }
  }
}
