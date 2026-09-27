import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { isFinished, Rejected, type Attempt, type Manager, type Task, type Usage } from './manager.ts';
import type { HistoryEntry } from './report.ts';
import type { IntegrationResult, Workspace } from './workspace.ts';
import type { Reviewer } from './reviewer.ts';
import type { VerifyCommand, VerifyResult } from './verify.ts';

// 실행 루프. tick 마다 ① 재조회·멈춤 알림 ② 검증 ③ 총괄 호출과 제안 적용을 한다.
// 상태는 모두 Manager(SQLite)에 있으므로 루프 프로세스가 죽어도 다시 띄우면 이어서 돈다.

export type Proposal =
  // prompt 를 주면 저장된 프롬프트 대신 쓴다. 선행 작업의 결과를 옮겨 담을 때 쓴다
  | { kind: 'dispatch'; taskId: string; expectedVersion: number; prompt?: string }
  | { kind: 'add_task'; id: string; prompt: string; dependsOn: string[]; blockedBy?: string; role?: string; verify?: string }
  | { kind: 'ask_user'; decisionId: string; question: string }
  | { kind: 'cancel_task'; taskId: string; reason: string };

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
  // 쓸 수 있는 작업자 역할 이름과 한 줄 설명
  roles?: { name: string; summary: string }[];
  // 모든 작업이 끝난 뒤 돌리는 인수 검증 명령과 가장 최근 결과
  acceptance?: string;
  lastAcceptance?: string;
  // 작업별 요약 (시도 횟수, 마지막 반려·재작업 이유, 취소 이유)
  notes?: ReturnType<Manager['taskNotes']>;
  specVersion?: number;
};

export interface Coordinator {
  // true 면 모든 작업이 done 이어도 총괄이 goalComplete 를 줘야 루프가 끝난다
  readonly decidesCompletion?: boolean;
  propose(s: Snapshot): Plan | Promise<Plan>;
}

export type { IntegrationResult };
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

// 작업 공간(빈 디렉터리 또는 git worktree)에 맞게 통합하고 검증한다.
// 작업에 검증 명령이 있으면 그것을, 없으면 기본 명령(run --verify)을, 둘 다 없으면 통과로 본다.
// 전체 인수 검증(run --accept)은 여기서 돌리지 않는다. 작업 하나로는 통과할 수 없는 경우가 있어서다
export function workspaceIntegrator(ws: Workspace, defaultVerify?: string, sandboxAllow: string[] = []): Integrator {
  return async (task, attempt) => ws.integrate(task, attempt, taskVerify(task, defaultVerify, sandboxAllow));
}

export function taskVerify(task: Task, defaultVerify?: string, sandboxAllow: string[] = []): VerifyCommand {
  if (task.verify) return { command: task.verify, trusted: task.verify_source === 'user', allow: sandboxAllow };
  return { command: defaultVerify ?? 'true', trusted: true };
}

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
  // 끝난 시도에서 권한 밖이라 거절당한 요청을 읽는다. 있으면 조용히 넘기지 않고 알린다
  readDenials?: (a: Attempt) => string[];
  // 독립 검토자. 있으면 통합 전에 변경을 검토하고, 반려하면 의견을 붙여 다시 돌린다
  reviewer?: Reviewer;
  // 검토자에게 보여 줄 변경 내용과 작업자의 마지막 응답
  changes?: (a: Attempt) => string;
  // 검토 전에 작업자의 작업 사본에서 작업별 검증을 돌린다 (의견 차이를 줄이는 짧은 실험)
  preCheck?: (t: Task, a: Attempt) => { passed: boolean; output: string } | undefined;
  readOutput?: (a: Attempt) => string | undefined;
  // 역할 이름 → 역할 지침. dispatch 할 때 작업 프롬프트 앞에 붙인다
  roles?: Record<string, string>;
  // 모든 작업 프롬프트 앞에 붙이는 작업 디렉터리 안내 (Workspace.workerNote)
  workerNote?: string;
  // 끝난 작업자 시도의 사용량을 읽는다. 예산 계산에 쓴다
  readUsage?: (a: Attempt) => Usage | undefined;
  // 전체 인수 검증. 모든 작업이 done 이 된 뒤 돌리고, 통과해야 루프가 끝난다
  accept?: { command: string; run: () => VerifyResult };
};

export type LoopResult = { status: 'done' | 'stopped' | 'max_ticks'; ticks: number };

// 총괄 제안 검증 상한
const MAX_NEW_TASKS_PER_PLAN = 10;
const MAX_TASKS = 50;
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
// 총괄 호출이 이만큼 연속 실패하면 멈춤으로 알린다
const COORDINATOR_FAILURE_ALERT = 3;

export async function tick(m: Manager, opts: LoopOptions): Promise<void> {
  // CLI 명령이 넣어 둔 요청을 먼저 반영한다. 상태를 고치는 것은 잠금을 쥔 루프 하나다
  m.applyRequests();
  await m.recover();
  if (opts.readDenials) checkDenials(m, opts.readDenials);
  if (opts.readUsage) recordWorkerUsage(m, opts.readUsage);

  for (const t of m.tasks().filter((x) => x.state === 'integrating')) {
    const a = m.lastSucceeded(t.id);
    if (!a) continue;
    if (opts.reviewer && !(await review(m, opts, t, a))) continue;
    const r = await opts.integrator(t, a);
    m.integrate(t.id, r.sha, r.passed, r.note);
    if (r.conflict) m.noteConflict(t.id);
    // 통합이 사람의 판단을 요구하면 작업마다 한 번 알린다. 그 작업이 done 이 되면 내린다
    if (r.alert) m.setFlag(`integration:${t.id}`, t.id, r.alert.reason, r.alert.next);
    if (r.passed) m.clearFlag(`integration:${t.id}`);
  }

  await consult(m, opts);
  if (opts.accept) checkAcceptance(m, opts.accept);
  checkIdle(m);
  // 새로 생긴 멈춤(시도 상한, 총괄 실패 등)은 제안을 적용한 뒤에도 확인한다
  m.alertIfNeeded();
}

// 진행이 멈췄는지 본다. 끝나지 않은 작업이 있는데 돌고 있는 작업자도, 통합 대기도 없고, 총괄이 지금 상태를
// 이미 보고도 아무것도 하지 않았으면 루프는 할 일 없이 돈다. 다른 멈춤 알림이 없을 때만 알린다
function checkIdle(m: Manager): void {
  const tasks = m.tasks();
  const seq = m.stateSeq();
  const unfinished = tasks.filter((t) => !isFinished(t));
  const idle = unfinished.length > 0
    && m.liveCount() === 0
    && !tasks.some((t) => t.state === 'integrating')
    && m.meta('coordinator_seq') === String(seq)
    && m.attention().every((a) => a.key.startsWith('idle:'));
  if (!idle) {
    m.clearFlagPrefix('idle:');
    return;
  }
  m.setFlag(`idle:${seq}`, null,
    `진행이 멈췄다: 끝나지 않은 작업 ${unfinished.length}개(${unfinished.slice(0, 5).map((t) => `${t.id}:${t.state}`).join(', ')})가 있는데 할 일이 없다`,
    '필요 없는 작업은 loop-ai cancel 로 치우고, 필요한 작업은 loop-ai add 로 넣는다. 실행 가능한데 멈췄다면 총괄 응답(coordinator_called)을 확인한다');
}

// 모든 작업이 done 이면 인수 검증을 돌린다. 같은 상태에서는 한 번만 돌린다.
// 실패하면 출력을 히스토리에 남겨 총괄이 고칠 작업을 추가할 수 있게 하고, 사용자에게도 알린다
function checkAcceptance(m: Manager, accept: NonNullable<LoopOptions['accept']>): void {
  const tasks = m.tasks();
  if (tasks.length === 0 || !tasks.every(isFinished)) return;
  const seq = String(m.stateSeq());
  if (m.meta('accept_seq') === seq) return;
  const r = accept.run();
  const out = r.output.split('\n').filter(Boolean).slice(-5).join(' | ').slice(0, 400) || '(출력 없음)';
  if (r.passed) {
    m.noteCoordinator('acceptance_passed', `인수 검증 통과: ${accept.command}`);
    m.clearFlagPrefix('acceptance:');
    m.setMeta('accept_passed', '1');
  } else {
    m.noteCoordinator('acceptance_failed', `인수 검증 실패: ${accept.command} → ${out}`);
    m.setMeta('accept_passed', '0');
    m.setFlag(`acceptance:${m.stateSeq()}`, null, `모든 작업이 끝났지만 인수 검증이 실패했다: ${out}`,
      '실패 출력을 보고 고칠 작업을 추가한다(loop-ai add). LLM 총괄이면 총괄이 이 실패를 보고 작업을 추가한다');
  }
  // 기록을 남긴 뒤의 번호로 표시한다. 상태가 다시 바뀌기 전에는 같은 검증을 되풀이하지 않는다
  m.setMeta('accept_seq', String(m.stateSeq()));
}

// 검토자 호출이 이만큼 연속 실패하면 멈춤으로 알린다
const REVIEWER_FAILURE_ALERT = 3;

// 통합해도 되면 true. 반려하면 작업을 다시 실행 가능으로 돌리고 의견을 남긴다. 검토자 호출이 실패하면
// 다음 tick 에 다시 검토한다 (false)
async function review(m: Manager, opts: LoopOptions, t: Task, a: Attempt): Promise<boolean> {
  const key = `review_ok:${a.id}`;
  if (m.meta(key)) return true;
  let v;
  try {
    const pre = opts.preCheck?.(t, a);
    const evidence = pre ? `${pre.passed ? 'PASSED' : 'FAILED'}${pre.output ? `: ${pre.output.slice(-800)}` : ''}` : undefined;
    const input = { goal: m.goal(), taskId: t.id, prompt: a.prompt, changes: opts.changes?.(a) ?? '', output: opts.readOutput?.(a), evidence };
    v = await opts.reviewer!(input);
    // 같은 작업이 연달아 반려되면 두 번째 검토자가 첫 검토자의 이유와 검증 결과를 함께 보고 판정한다.
    // 반려·재시도가 끝없이 되풀이되지 않게 하려는 것이다 (합의안: 의견이 다르면 확인 가능한 것은 실험으로)
    if (!v.approve && Number(m.meta(`review_rejects:${t.id}`) ?? 0) >= 1) {
      const first = v;
      v = await opts.reviewer!({ ...input, priorIssues: first.issues.map((x) => `- ${x}`).join('\n') || first.summary });
      m.noteReview(t.id, a.id, v.approve, `두 번째 검토자 ${v.approve ? '승인' : '반려'}: ${v.summary}`);
    }
  } catch (e) {
    const n = Number(m.meta('review_failures') ?? 0) + 1;
    m.setMeta('review_failures', String(n));
    const msg = e instanceof Error ? e.message : String(e);
    m.noteCoordinator('review_failed', `검토자 호출 실패 ${n}회째: ${msg.slice(0, 200)}`);
    if (n >= REVIEWER_FAILURE_ALERT) {
      m.setFlag('reviewer_failed', null, `검토자 호출이 ${n}번 연속 실패했다: ${msg.slice(0, 200)}`,
        '검토자 CLI 가 로그인돼 있는지, 네트워크와 사용량 한도를 확인한다. 루프는 다음 tick 에 다시 부른다');
    }
    return false;
  }
  m.setMeta('review_failures', '0');
  m.clearFlag('reviewer_failed');
  if (v.approve) {
    m.setMeta(key, '1');
    m.setMeta(`review_rejects:${t.id}`, '0');
    m.noteReview(t.id, a.id, true, v.summary);
    return true;
  }
  m.setMeta(`review_rejects:${t.id}`, String(Number(m.meta(`review_rejects:${t.id}`) ?? 0) + 1));
  const feedback = v.issues.length ? v.issues.map((x) => `- ${x}`).join('\n') : v.summary;
  m.setMeta(`review_feedback:${t.id}`, feedback);
  m.noteReview(t.id, a.id, false, `${v.summary} | ${v.issues.join(' / ')}`);
  m.integrate(t.id, 'review', false, `검토 반려: ${v.summary}`);
  return false;
}

// dispatch 할 프롬프트를 만든다. 역할 지침을 앞에, 이전 검토 의견을 뒤에 붙인다
function composePrompt(m: Manager, opts: LoopOptions, t: Task, base: string): string {
  const role = t.role ? opts.roles?.[t.role] : undefined;
  const fb = m.meta(`review_feedback:${t.id}`);
  return [
    opts.workerNote ? `${opts.workerNote}\n\n` : '',
    role ? `${role.trim()}\n\n---\n` : '',
    base,
    fb ? `\n\nReviewer feedback on the previous attempt. Fix these:\n${fb}` : '',
  ].join('');
}

// 끝난 시도마다 한 번씩 작업자 사용량을 기록한다
function recordWorkerUsage(m: Manager, read: (a: Attempt) => Usage | undefined): void {
  for (const t of m.tasks()) {
    for (const a of m.attempts(t.id)) {
      if (a.status !== 'succeeded' && a.status !== 'failed') continue;
      const key = `usage_recorded:${a.id}`;
      if (m.meta(key)) continue;
      m.setMeta(key, '1');
      const u = read(a);
      if (u) m.recordUsage('worker', u, t.id, a.id);
    }
  }
}

// 끝난 시도마다 한 번씩 권한 거절을 확인한다. 거절은 작업을 멈추지 않지만, 정책 밖 행동이 필요했다는
// 뜻이라 사용자가 알아야 한다. 재시도마다 알리지 않도록 작업마다 한 번만 알리고, 그 작업이 done 이 되면 내린다
function checkDenials(m: Manager, read: (a: Attempt) => string[]): void {
  for (const t of m.tasks()) {
    if (t.state === 'done') m.clearFlag(`denied:${t.id}`);
    for (const a of m.attempts(t.id)) {
      if (a.status !== 'succeeded' && a.status !== 'failed') continue;
      const key = `denials_checked:${a.id}`;
      if (m.meta(key)) continue;
      m.setMeta(key, '1');
      const denied = read(a);
      if (denied.length === 0 || t.state === 'done') continue;
      m.noteDenied(t.id, a.id, denied);
      m.setFlag(`denied:${t.id}`, t.id, `작업자가 권한 밖 요청 ${denied.length}건을 거절당했다: ${denied.slice(0, 3).join(', ')}`,
        '작업 결과가 목표에 모자라면 작업을 나누거나 프롬프트를 고친다. 정말 필요한 권한이면 loop-ai policy 로 수준을 올린다');
    }
  }
}

// 상태가 바뀌었을 때만 총괄을 부른다. LLM 총괄은 부를 때마다 비용이 들기 때문이다
async function consult(m: Manager, opts: LoopOptions): Promise<void> {
  const coordinator = opts.coordinator ?? inOrderCoordinator;
  const capacity = opts.maxConcurrent - m.liveCount();
  // 예산을 넘으면 새 작업을 내지 않고 총괄도 부르지 않는다. 돌고 있는 작업자는 멈추지 않는다
  const over = m.budgetExceeded();
  const b = m.budget();
  const budgetKey = `budget:${b.maxMinutes ?? '-'}:${b.maxCostUsd ?? '-'}:${b.startedAt ?? '-'}`;
  if (over) {
    m.setFlag(budgetKey, null, `예산을 넘어 새 작업을 멈췄다: ${over}`,
      '예산을 늘리거나(loop-ai budget) 남은 작업을 줄인다. 돌고 있는 작업자는 끝날 때까지 둔다');
    return;
  }
  m.clearFlagPrefix('budget:');
  const seq = m.stateSeq();
  if (String(seq) === m.meta('coordinator_seq') || capacity <= 0) return;

  let plan: Plan;
  try {
    plan = await coordinator.propose({
      goal: m.goal(), tasks: m.tasks(), runnable: m.runnable(), capacity,
      attempts: m.attemptCounts(), decisions: m.decisions(), history: m.history(30),
      roles: Object.entries(opts.roles ?? {}).map(([name, text]) => ({ name, summary: summarize(text) })),
      acceptance: opts.accept?.command,
      lastAcceptance: m.lastAcceptance(),
      notes: m.taskNotes(),
      specVersion: m.specVersion(),
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

  const changed = await applyPlan(m, plan, capacity, opts);
  m.setMeta('goal_complete', plan.goalComplete === true ? '1' : '0');
  // 모든 작업이 끝났는데 총괄이 목표 미완료라 하면서 다음 작업을 내지 않으면 루프가 할 일이 없다. 알린다
  const done = m.tasks().length > 0 && m.tasks().every(isFinished);
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
async function applyPlan(m: Manager, plan: Plan, capacity: number, opts: LoopOptions): Promise<boolean> {
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
        if (p.role && !opts.roles?.[p.role]) throw new Rejected(`없는 역할: ${p.role}`);
        if (p.verify && p.verify.length > 500) throw new Rejected(`검증 명령이 너무 길다: ${p.id}`);
        // 총괄이 제안한 검증 명령은 샌드박스 안에서만 돈다 (verify.ts)
        m.addTask(p.id, { prompt: p.prompt, dependsOn: p.dependsOn ?? [], blockedBy: p.blockedBy, role: p.role, verify: p.verify, verifySource: 'coordinator' });
        added++;
      } else if (p.kind === 'ask_user') {
        if (!ID.test(p.decisionId)) throw new Rejected(`결정 ID 형식이 아니다: ${p.decisionId}`);
        if (m.hasDecision(p.decisionId)) throw new Rejected(`이미 있는 결정: ${p.decisionId}`);
        if (asked >= 1) throw new Rejected('사용자 질문은 한 번에 하나만 한다');
        if (!p.question?.trim()) throw new Rejected('질문이 비었다');
        m.openDecision(p.decisionId, p.question);
        asked++;
      } else if (p.kind === 'cancel_task') {
        m.cancelTask(p.taskId, `총괄이 취소: ${p.reason ?? ''}`);
        added++; // 상태를 바꿨으니 다음 tick 에 총괄을 다시 부른다
      } else if (p.kind === 'dispatch') {
        if (dispatched >= capacity) throw new Rejected(`동시 실행 상한을 넘는 제안: ${p.taskId}`);
        const t = m.task(p.taskId);
        // 버전·상태·선행 작업·시도 상한 검증은 dispatch 가 한다
        await m.dispatch(t.id, p.expectedVersion, composePrompt(m, opts, t, p.prompt?.trim() ? p.prompt : t.prompt));
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
    const allDone = tasks.length > 0 && tasks.every(isFinished);
    const accepted = !opts.accept || (m.meta('accept_passed') === '1' && m.meta('accept_seq') === String(m.stateSeq()));
    if (allDone && accepted && (!coordinator.decidesCompletion || m.meta('goal_complete') === '1')) return { status: 'done', ticks };
    if (opts.maxTicks !== undefined && ticks >= opts.maxTicks) return { status: 'max_ticks', ticks };
    // 멈춘 작업만 남아도 끝내지 않는다. 사용자 응답·판정이 들어오면 다음 tick 에서 이어 간다
    try {
      await sleep(opts.intervalMs, undefined, { signal: opts.signal });
    } catch {
      return { status: 'stopped', ticks };
    }
  }
}

// 역할 지침의 첫 설명 줄. 마크다운 머리말(---)이 있으면 description 을 쓴다
function summarize(text: string): string {
  const m = /^description:\s*(.+)$/m.exec(text);
  if (m) return m[1]!.slice(0, 160);
  return (text.split('\n').find((l) => l.trim() && !l.startsWith('---') && !l.startsWith('#')) ?? '').slice(0, 160);
}
