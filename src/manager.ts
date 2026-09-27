import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Adapter } from './adapter.ts';
import { renderReport, type Attention, type HistoryEntry } from './report.ts';

// 상태를 쓰는 것은 이 클래스 하나뿐이다. 총괄·작업자는 제안만 하고, 여기서 버전과 전이를 검증한다.
// 외부 실행은 exactly-once 를 보장하지 않는다. 이벤트는 at-least-once 로 오고, 중복은 억제하고,
// 상태를 알 수 없으면 launch_unknown 으로 남겨 조사한다.
// 멈춘 작업은 조용히 기다리지 않는다. 처음 발견했을 때 상태·히스토리·다음 할 일을 담은 보고서를 알린다.

export class Rejected extends Error {}
export class SimulatedCrash extends Error {}

export type TaskState = 'ready' | 'blocked' | 'running' | 'integrating' | 'done';
export type AttemptStatus = 'intent' | 'launched' | 'launch_unknown' | 'succeeded' | 'failed';

export type Task = {
  id: string; state: TaskState; version: number; blocked_by: string | null; commit_sha: string | null;
  prompt: string; depends_on: string; max_attempts: number;
};
export type TaskOptions = { prompt?: string; blockedBy?: string; dependsOn?: string[]; maxAttempts?: number };
export type Attempt = {
  id: string; task_id: string; request_id: string; workdir: string; prompt: string; status: AttemptStatus;
  last_lookup: string | null; started_at?: number | null;
};
export type Notify = (report: string) => void;
// stallAfterMs: 작업자가 살아 있어도 이 시간을 넘기면 멈춤으로 알린다. 죽이거나 재시도하지는 않는다
export type ManagerOptions = { stallAfterMs?: number; now?: () => number };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, state TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0,
  blocked_by TEXT, commit_sha TEXT,
  prompt TEXT NOT NULL DEFAULT '', depends_on TEXT NOT NULL DEFAULT '', max_attempts INTEGER NOT NULL DEFAULT 3
);
CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
  request_id TEXT NOT NULL UNIQUE, workdir TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL,
  last_lookup TEXT, started_at INTEGER
);
-- Task 하나에 권한 있는 시도는 동시에 1개까지
CREATE UNIQUE INDEX IF NOT EXISTS one_live_attempt ON attempts(task_id)
  WHERE status IN ('intent', 'launched', 'launch_unknown');
CREATE TABLE IF NOT EXISTS events (key TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, result TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY, spec_version INTEGER NOT NULL, status TEXT NOT NULL, answer TEXT, question TEXT
);
-- 작업·시도에 묶이지 않는 멈춤(총괄 호출 실패 등). active 인 것만 attention 에 오른다
CREATE TABLE IF NOT EXISTS flags (key TEXT PRIMARY KEY, task_id TEXT, reason TEXT NOT NULL, next TEXT NOT NULL, active INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS history (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, task_id TEXT, attempt_id TEXT, kind TEXT NOT NULL, detail TEXT NOT NULL
);
-- 이미 알린 멈춤. 같은 멈춤을 루프마다 다시 알리지 않는다
CREATE TABLE IF NOT EXISTS alerts (key TEXT PRIMARY KEY, at TEXT NOT NULL);
`;

export class Manager {
  readonly db: DatabaseSync;
  readonly adapter: Adapter;
  readonly workRoot: string;
  readonly notify: Notify | undefined;

  readonly stallAfterMs: number;
  readonly now: () => number;

  constructor(dbPath: string, adapter: Adapter, workRoot: string, notify?: Notify, opts: ManagerOptions = {}) {
    this.stallAfterMs = opts.stallAfterMs ?? 15 * 60_000;
    this.now = opts.now ?? Date.now;
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this.migrate();
    this.adapter = adapter;
    this.workRoot = workRoot;
    this.notify = notify;
  }

  // 이전 버전이 만든 DB 에 없는 열을 채운다. CREATE TABLE IF NOT EXISTS 는 기존 표에 열을 더하지 않는다
  private migrate(): void {
    const has = (table: string, col: string) =>
      (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
    const add: [string, string, string][] = [
      ['tasks', 'prompt', `TEXT NOT NULL DEFAULT ''`],
      ['tasks', 'depends_on', `TEXT NOT NULL DEFAULT ''`],
      ['tasks', 'max_attempts', 'INTEGER NOT NULL DEFAULT 3'],
      ['attempts', 'last_lookup', 'TEXT'],
      ['decisions', 'question', 'TEXT'],
      ['attempts', 'started_at', 'INTEGER'],
    ];
    for (const [table, col, def] of add) {
      if (!has(table, col)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    }
  }

  // dispatch·recover 를 한 관리자 안에서 한 줄로 세운다. 겹치면 같은 시도를 두 번 띄울 수 있다
  private queue: Promise<unknown> = Promise.resolve();
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private log(taskId: string | null, attemptId: string | null, kind: string, detail: string): void {
    this.db.prepare('INSERT INTO history (at, task_id, attempt_id, kind, detail) VALUES (?, ?, ?, ?, ?)')
      .run(new Date().toISOString(), taskId, attemptId, kind, detail);
  }

  history(limit = 20): HistoryEntry[] {
    const rows = this.db.prepare('SELECT at, task_id, attempt_id, kind, detail FROM history ORDER BY seq DESC LIMIT ?').all(limit) as HistoryEntry[];
    return rows.reverse();
  }

  close(): void {
    this.db.close();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  specVersion(): number {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'spec_version'`).get() as { value: string } | undefined;
    return row ? Number(row.value) : 1;
  }

  meta(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  goal(): string {
    return this.meta('goal') ?? '';
  }

  setGoal(goal: string): void {
    this.setMeta('goal', goal);
    this.log(null, null, 'goal_set', goal.split('\n')[0]!.slice(0, 120));
  }

  // 마지막 히스토리 번호. 총괄은 이 값이 바뀌었을 때만 다시 부른다
  historySeq(): number {
    return (this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM history').get() as { n: number }).n;
  }

  // 작업 상태를 바꾼 기록만 센 마지막 번호. 알림·거절·총괄 실패 같은 기록은 총괄을 다시 부를 이유가 아니다
  stateSeq(): number {
    return (this.db.prepare(`SELECT COALESCE(MAX(seq), 0) AS n FROM history
      WHERE kind NOT IN ('alerted', 'alert_failed', 'proposal_rejected', 'coordinator_failed', 'coordinator_called', 'permission_denied')`).get() as { n: number }).n;
  }

  attemptCounts(): Record<string, number> {
    const rows = this.db.prepare('SELECT task_id, COUNT(*) AS n FROM attempts GROUP BY task_id').all() as { task_id: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.task_id, r.n]));
  }

  decisions(): { id: string; spec_version: number; status: string; question: string | null; answer: string | null }[] {
    return this.db.prepare('SELECT id, spec_version, status, question, answer FROM decisions ORDER BY rowid').all() as never;
  }

  // 작업·시도에 묶이지 않는 멈춤을 올리거나 내린다
  setFlag(key: string, taskId: string | null, reason: string, next: string): void {
    this.db.prepare(`INSERT INTO flags (key, task_id, reason, next, active) VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(key) DO UPDATE SET reason = excluded.reason, next = excluded.next, active = 1`).run(key, taskId, reason, next);
  }

  clearFlag(key: string): void {
    this.db.prepare('UPDATE flags SET active = 0 WHERE key = ?').run(key);
  }

  clearFlagPrefix(prefix: string): void {
    this.db.prepare(`UPDATE flags SET active = 0 WHERE key LIKE ? || '%'`).run(prefix);
  }

  noteDenied(taskId: string, attemptId: string, denied: string[]): void {
    this.log(taskId, attemptId, 'permission_denied', denied.join(', ').slice(0, 300));
  }

  // 총괄 호출에 관한 기록. 작업에 묶이지 않는다
  noteCoordinator(kind: string, detail: string): void {
    this.log(null, null, kind, detail);
  }

  setSpecVersion(v: number): void {
    this.db.prepare(`INSERT INTO meta (key, value) VALUES ('spec_version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(v));
  }

  addTask(id: string, opts: TaskOptions = {}): void {
    const { prompt = '', blockedBy, dependsOn = [], maxAttempts = 3 } = opts;
    this.db.prepare('INSERT INTO tasks (id, state, blocked_by, prompt, depends_on, max_attempts) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, blockedBy ? 'blocked' : 'ready', blockedBy ?? null, prompt, dependsOn.join(','), maxAttempts);
    const why = [blockedBy && `결정 ${blockedBy} 대기`, dependsOn.length && `선행 ${dependsOn.join(', ')}`].filter(Boolean).join(', ');
    this.log(id, null, 'task_added', why ? `추가 (${why})` : '실행 가능으로 추가');
  }

  tasks(): Task[] {
    return this.db.prepare('SELECT * FROM tasks ORDER BY rowid').all() as Task[];
  }

  private attemptCount(taskId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?').get(taskId) as { n: number }).n;
  }

  private depsDone(t: Task): boolean {
    const deps = t.depends_on ? t.depends_on.split(',') : [];
    return deps.every((d) => this.task(d).state === 'done');
  }

  // 권한 있는 시도(intent·launched·launch_unknown) 수. 동시 실행 상한에 쓴다
  liveCount(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM attempts WHERE status IN ('intent', 'launched', 'launch_unknown')`).get() as { n: number }).n;
  }

  lastSucceeded(taskId: string): Attempt | undefined {
    return this.db.prepare(`SELECT * FROM attempts WHERE task_id = ? AND status = 'succeeded' ORDER BY rowid DESC LIMIT 1`).get(taskId) as Attempt | undefined;
  }

  // 시도 횟수 상한에 닿은 작업에 기회를 더 준다. 사람이 원인을 확인한 뒤 부른다
  grantAttempts(taskId: string, n: number): void {
    this.db.prepare('UPDATE tasks SET max_attempts = max_attempts + ? WHERE id = ?').run(n, taskId);
    this.log(taskId, null, 'attempts_granted', `시도 ${n}회 추가`);
  }

  task(id: string): Task {
    const t = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
    if (!t) throw new Rejected(`없는 작업: ${id}`);
    return t;
  }

  attempts(taskId: string): Attempt[] {
    return this.db.prepare('SELECT * FROM attempts WHERE task_id = ? ORDER BY rowid').all(taskId) as Attempt[];
  }

  // 지금 dispatch 할 수 있는 작업: ready 이고, 선행 작업이 끝났고, 시도 횟수가 남았다
  runnable(): string[] {
    return this.tasks()
      .filter((t) => t.state === 'ready' && this.depsDone(t) && this.attemptCount(t.id) < t.max_attempts)
      .map((t) => t.id);
  }

  private bump(taskId: string, state: TaskState): void {
    this.db.prepare('UPDATE tasks SET state = ?, version = version + 1 WHERE id = ?').run(state, taskId);
  }

  // 총괄의 "이 작업을 실행하라" 제안. expectedVersion 은 총괄이 보고 판단한 상태 버전이다.
  dispatch(taskId: string, expectedVersion: number, prompt: string, crashAt?: 'after_intent' | 'after_launch'): Promise<Attempt> {
    return this.serial(() => this.dispatchNow(taskId, expectedVersion, prompt, crashAt));
  }

  private async dispatchNow(taskId: string, expectedVersion: number, prompt: string, crashAt?: 'after_intent' | 'after_launch'): Promise<Attempt> {
    // 실행 전에 attempt ID·request_id·작업 디렉터리·시작 의도를 먼저 저장한다
    const attempt = this.tx(() => {
      const t = this.task(taskId);
      if (t.version !== expectedVersion) throw new Rejected(`상태 버전이 다르다: 현재 ${t.version}, 제안 ${expectedVersion}`);
      if (t.state !== 'ready') throw new Rejected(`실행 가능 상태가 아니다: ${t.state}`);
      if (!this.depsDone(t)) throw new Rejected(`선행 작업이 끝나지 않았다: ${t.depends_on}`);
      if (this.attemptCount(taskId) >= t.max_attempts) throw new Rejected(`시도 횟수 상한 ${t.max_attempts}회에 닿았다`);
      const id = randomUUID();
      const a: Attempt = { id, task_id: taskId, request_id: `req-${id}`, workdir: path.join(this.workRoot, id), prompt, status: 'intent', last_lookup: null };
      this.db.prepare('INSERT INTO attempts (id, task_id, request_id, workdir, prompt, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(a.id, a.task_id, a.request_id, a.workdir, a.prompt, a.status, this.now());
      this.bump(taskId, 'running');
      this.log(taskId, id, 'intent', `실행 의도 저장 (${a.request_id})`);
      return a;
    });
    if (crashAt === 'after_intent') throw new SimulatedCrash('의도 저장 직후');
    await this.adapter.launch({ requestId: attempt.request_id, workdir: attempt.workdir, prompt: attempt.prompt });
    if (crashAt === 'after_launch') throw new SimulatedCrash('실행 직후, launched 기록 전');
    this.db.prepare(`UPDATE attempts SET status = 'launched' WHERE id = ? AND status = 'intent'`).run(attempt.id);
    this.log(taskId, attempt.id, 'launched', `작업자 실행 (${attempt.workdir})`);
    return { ...attempt, status: 'launched' };
  }

  // 재시작 뒤 끝나지 않은 시도를 request_id 로 다시 조회해 이어 간다
  // 재시작 뒤 끝나지 않은 시도를 request_id 로 다시 조회해 이어 간다
  recover(): Promise<void> {
    return this.serial(() => this.recoverNow());
  }

  private async recoverNow(): Promise<void> {
    // launch_unknown 도 계속 조회한다. 다시 시작하지는 않지만, 확실한 근거가 나오면 반영한다
    const live = this.db.prepare(`SELECT * FROM attempts WHERE status IN ('intent', 'launched', 'launch_unknown') ORDER BY rowid`).all() as Attempt[];
    for (const a of live) {
      const r = await this.adapter.lookup(a.request_id);
      // 조회를 기다리는 사이 다른 쪽이 이 시도를 바꿨다면 읽은 값은 낡았다. 건드리지 않는다
      const now = this.db.prepare('SELECT status FROM attempts WHERE id = ?').get(a.id) as { status: AttemptStatus };
      if (now.status !== a.status) continue;

      if (r === 'running') {
        if (a.status !== 'launched') this.log(a.task_id, a.id, 'recovered', `재조회: 실행 중 (${a.status} → launched)`);
        this.moveAttempt(a, 'launched', r);
      } else if (r === 'succeeded' || r === 'failed') {
        this.onResult(`lookup:${a.id}`, a.id, r);
      } else if (r === 'not_found' && a.status === 'intent') {
        // 시작된 적이 없다고 어댑터가 확인해 줬으므로 같은 request_id 로 시작한다
        await this.adapter.launch({ requestId: a.request_id, workdir: a.workdir, prompt: a.prompt });
        this.moveAttempt(a, 'launched', r);
        this.log(a.task_id, a.id, 'launched', '재조회: 시작된 적 없음 → 같은 request_id 로 시작');
      } else if (a.status === 'intent' || (a.status === 'launched' && r === 'not_found')) {
        // 시작됐는지 알 수 없다. 다시 시작하지 않고 조사 대상으로 남긴다
        this.moveAttempt(a, 'launch_unknown', r);
        this.log(a.task_id, a.id, 'launch_unknown', `재조회 결과 ${r}: 시작 여부를 알 수 없어 다시 시작하지 않음`);
      } else if (a.status === 'launched') {
        // launched + unknown: 재시도하지 않고 기다리되, 처음 발견한 순간 기록하고 알린다
        if (a.last_lookup !== 'unknown') this.log(a.task_id, a.id, 'lost', '종료 코드도 실행 중인 프로세스도 찾지 못함');
        this.moveAttempt(a, 'launched', r);
      }
      // launch_unknown + not_found/unknown: 그대로 둔다
    }
    this.alertIfNeeded();
  }

  // 사람의 손이 필요한 곳. 비어 있지 않으면 루프는 이 작업들에서 멈춰 있다
  attention(): Attention[] {
    const items: Attention[] = [];
    const stuck = this.db.prepare(`SELECT * FROM attempts WHERE status = 'launch_unknown'
      OR (status = 'launched' AND last_lookup = 'unknown') ORDER BY rowid`).all() as Attempt[];
    for (const a of stuck) {
      const unknownLaunch = a.status === 'launch_unknown';
      items.push({
        key: `${unknownLaunch ? 'launch_unknown' : 'lost'}:${a.id}`,
        taskId: a.task_id,
        reason: unknownLaunch ? '작업자가 시작됐는지 알 수 없다' : '작업자가 종료 코드 없이 사라졌거나 살아 있는지 확인할 수 없다',
        next: `작업 디렉터리 ${a.workdir} 와 CLI 실행 기록(request_id ${a.request_id})을 확인해 끝났는지 판정한 뒤 resolveUnknown('${a.id}', 'succeeded' | 'failed') 를 입력한다`,
      });
    }
    for (const t of this.tasks()) {
      const n = this.attemptCount(t.id);
      if (t.state !== 'ready' || n < t.max_attempts) continue;
      items.push({
        key: `exhausted:${t.id}:${n}`,
        taskId: t.id,
        reason: `${n}번 시도했지만 끝나지 않아 더 시도하지 않는다`,
        next: `시도 기록(history, 작업 디렉터리)을 보고 원인을 고친 뒤 grantAttempts('${t.id}', 1) 로 다시 허용한다`,
      });
    }
    // 살아 있지만 너무 오래 끝나지 않는 작업자. 권한 요청을 기다리며 멈춘 CLI 가 이렇게 보인다
    const slow = this.db.prepare(`SELECT * FROM attempts WHERE status = 'launched' AND last_lookup = 'running'
      AND started_at IS NOT NULL AND started_at < ? ORDER BY rowid`).all(this.now() - this.stallAfterMs) as Attempt[];
    for (const a of slow) {
      const min = Math.floor((this.now() - a.started_at!) / 60_000);
      items.push({
        key: `slow:${a.id}`,
        taskId: a.task_id,
        reason: `작업자가 ${min}분째 끝나지 않는다 (프로세스는 살아 있다)`,
        next: `${a.workdir} 의 out.jsonl·err.txt 를 확인한다. 멈춘 것이면 표지 loop-ai:${a.request_id} 가 붙은 프로세스 그룹을 종료한다. 그러면 다음 tick 에 사라진 작업자로 보고되고 resolveUnknown 으로 판정할 수 있다`,
      });
    }
    const open = this.db.prepare(`SELECT id, spec_version, question FROM decisions WHERE status = 'open' ORDER BY rowid`).all() as { id: string; spec_version: number; question: string | null }[];
    for (const d of open) {
      const blocked = (this.db.prepare(`SELECT id FROM tasks WHERE blocked_by = ?`).all(d.id) as { id: string }[]).map((t) => t.id);
      items.push({
        key: `decision:${d.id}`,
        taskId: blocked.join(', ') || null,
        reason: `사용자 결정 ${d.id} 를 기다린다${d.question ? `: ${d.question}` : ''}`,
        next: `answerDecision('${d.id}', ${d.spec_version}, '<응답>') 를 입력한다`,
      });
    }
    const flags = this.db.prepare('SELECT * FROM flags WHERE active = 1 ORDER BY rowid').all() as { key: string; task_id: string | null; reason: string; next: string }[];
    for (const f of flags) items.push({ key: f.key, taskId: f.task_id, reason: f.reason, next: f.next });
    return items;
  }

  report(): string {
    return renderReport({ at: new Date().toISOString(), tasks: this.tasks(), runnable: this.runnable(), attention: this.attention(), history: this.history() });
  }

  // 새로 멈춘 곳이 있으면 알린다. 실제로 전달된 뒤에만 보낸 것으로 기록하고, 실패하면 다음에 다시 보낸다.
  // 전달했으면 true
  alertIfNeeded(): boolean {
    const fresh = this.attention().filter((a) => !this.db.prepare('SELECT 1 FROM alerts WHERE key = ?').get(a.key));
    if (fresh.length === 0) return false;
    // notify 가 없으면 표준 오류로라도 남긴다. 조용히 넘어가지 않는다
    const send = this.notify ?? ((r: string) => { process.stderr.write(r + '\n'); });
    try {
      send(this.report());
    } catch (e) {
      this.log(null, null, 'alert_failed', `알림 전달 실패, 다음에 다시 보낸다: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
    const at = new Date().toISOString();
    for (const a of fresh) {
      this.db.prepare('INSERT INTO alerts (key, at) VALUES (?, ?)').run(a.key, at);
      this.log(a.taskId, null, 'alerted', `${a.reason} → 사용자에게 알림`);
    }
    return true;
  }

  // 총괄의 제안이 검증에서 거절된 것을 남긴다
  noteRejected(taskId: string, reason: string): void {
    this.log(taskId, null, 'proposal_rejected', reason);
  }

  // 멈춘 시도에 대한 사람의 판정. 확인한 결과를 이벤트로 반영한다
  resolveUnknown(attemptId: string, verdict: 'succeeded' | 'failed'): void {
    const a = this.db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId) as Attempt | undefined;
    if (!a) throw new Rejected(`없는 시도: ${attemptId}`);
    if (!(a.status === 'launch_unknown' || (a.status === 'launched' && a.last_lookup === 'unknown'))) {
      throw new Rejected(`판정할 대상이 아니다: ${a.status}, last_lookup ${a.last_lookup}`);
    }
    this.log(a.task_id, a.id, 'resolved', `사람이 ${verdict} 로 판정`);
    this.onResult(`human:${a.id}`, a.id, verdict);
  }

  // 읽었을 때의 상태가 그대로일 때만 바꾼다. 그 사이 다른 쪽이 바꿨으면 아무것도 하지 않는다
  private moveAttempt(a: Attempt, status: AttemptStatus, lastLookup: string): boolean {
    return this.db.prepare('UPDATE attempts SET status = ?, last_lookup = ? WHERE id = ? AND status = ?')
      .run(status, lastLookup, a.id, a.status).changes === 1;
  }

  // 완료·실패 이벤트. 같은 key 로 두 번 와도 한 번만 반영한다
  onResult(eventKey: string, attemptId: string, result: 'succeeded' | 'failed'): boolean {
    return this.tx(() => {
      const ins = this.db.prepare('INSERT OR IGNORE INTO events (key, attempt_id, result) VALUES (?, ?, ?)').run(eventKey, attemptId, result);
      if (ins.changes === 0) return false;
      const upd = this.db.prepare(`UPDATE attempts SET status = ? WHERE id = ? AND status IN ('intent', 'launched', 'launch_unknown')`)
        .run(result, attemptId);
      if (upd.changes === 0) return false;
      const { task_id } = this.db.prepare('SELECT task_id FROM attempts WHERE id = ?').get(attemptId) as { task_id: string };
      // 실패가 확인된 시도만 재시도 대상이 된다
      this.bump(task_id, result === 'succeeded' ? 'integrating' : 'ready');
      this.log(task_id, attemptId, result, result === 'succeeded' ? '작업자 실행 종료 → 통합 대기' : '실패 확인 → 다시 실행 가능');
      return true;
    });
  }

  hasDecision(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM decisions WHERE id = ?').get(id);
  }

  openDecision(id: string, question?: string): void {
    this.db.prepare(`INSERT INTO decisions (id, spec_version, status, question) VALUES (?, ?, 'open', ?)`).run(id, this.specVersion(), question ?? null);
    this.log(null, null, 'decision_opened', `결정 ${id} 를 사용자에게 요청${question ? `: ${question}` : ''}`);
    this.alertIfNeeded();
  }

  // 사용자 응답. decision ID 와 스펙 버전이 맞아야 받는다
  answerDecision(id: string, specVersion: number, answer: string): void {
    this.tx(() => {
      const d = this.db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as { spec_version: number; status: string } | undefined;
      if (!d) throw new Rejected(`없는 결정: ${id}`);
      if (d.status !== 'open') throw new Rejected(`이미 응답을 받은 결정: ${id}`);
      if (specVersion !== d.spec_version || specVersion !== this.specVersion()) {
        throw new Rejected(`스펙 버전이 다르다: 결정 ${d.spec_version}, 현재 ${this.specVersion()}, 응답 ${specVersion}`);
      }
      this.db.prepare(`UPDATE decisions SET status = 'answered', answer = ? WHERE id = ?`).run(answer, id);
      this.db.prepare(`UPDATE tasks SET state = 'ready', blocked_by = NULL, version = version + 1 WHERE blocked_by = ? AND state = 'blocked'`).run(id);
      this.log(null, null, 'decision_answered', `결정 ${id} 응답: ${answer}`);
    });
  }

  // 통합된 SHA 에서 검증을 통과해야 done 이 된다
  integrate(taskId: string, commitSha: string, testsPassed: boolean): void {
    this.tx(() => {
      const t = this.task(taskId);
      if (t.state !== 'integrating') throw new Rejected(`통합 단계가 아니다: ${t.state}`);
      if (testsPassed) {
        this.db.prepare(`UPDATE tasks SET state = 'done', commit_sha = ?, version = version + 1 WHERE id = ?`).run(commitSha, taskId);
        this.log(taskId, null, 'done', `검증 통과 (${commitSha})`);
      } else {
        this.bump(taskId, 'ready');
        this.log(taskId, null, 'rework', `검증 실패 (${commitSha}) → 다시 실행 가능`);
      }
    });
  }
}
