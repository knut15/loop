import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Adapter } from './adapter.ts';

// 상태를 쓰는 것은 이 클래스 하나뿐이다. 총괄·작업자는 제안만 하고, 여기서 버전과 전이를 검증한다.
// 외부 실행은 exactly-once 를 보장하지 않는다. 이벤트는 at-least-once 로 오고, 중복은 억제하고,
// 상태를 알 수 없으면 launch_unknown 으로 남겨 조사한다.

export class Rejected extends Error {}
export class SimulatedCrash extends Error {}

export type TaskState = 'ready' | 'blocked' | 'running' | 'integrating' | 'done';
export type AttemptStatus = 'intent' | 'launched' | 'launch_unknown' | 'succeeded' | 'failed';

export type Task = { id: string; state: TaskState; version: number; blocked_by: string | null; commit_sha: string | null };
export type Attempt = { id: string; task_id: string; request_id: string; workdir: string; prompt: string; status: AttemptStatus };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, state TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0,
  blocked_by TEXT, commit_sha TEXT
);
CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
  request_id TEXT NOT NULL UNIQUE, workdir TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL
);
-- Task 하나에 권한 있는 시도는 동시에 1개까지
CREATE UNIQUE INDEX IF NOT EXISTS one_live_attempt ON attempts(task_id)
  WHERE status IN ('intent', 'launched', 'launch_unknown');
CREATE TABLE IF NOT EXISTS events (key TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, result TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY, spec_version INTEGER NOT NULL, status TEXT NOT NULL, answer TEXT
);
`;

export class Manager {
  readonly db: DatabaseSync;
  readonly adapter: Adapter;
  readonly workRoot: string;

  constructor(dbPath: string, adapter: Adapter, workRoot: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this.adapter = adapter;
    this.workRoot = workRoot;
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

  setSpecVersion(v: number): void {
    this.db.prepare(`INSERT INTO meta (key, value) VALUES ('spec_version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(v));
  }

  addTask(id: string, blockedBy?: string): void {
    this.db.prepare('INSERT INTO tasks (id, state, blocked_by) VALUES (?, ?, ?)')
      .run(id, blockedBy ? 'blocked' : 'ready', blockedBy ?? null);
  }

  task(id: string): Task {
    const t = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
    if (!t) throw new Rejected(`없는 작업: ${id}`);
    return t;
  }

  attempts(taskId: string): Attempt[] {
    return this.db.prepare('SELECT * FROM attempts WHERE task_id = ? ORDER BY rowid').all(taskId) as Attempt[];
  }

  runnable(): string[] {
    return (this.db.prepare(`SELECT id FROM tasks WHERE state = 'ready' ORDER BY rowid`).all() as { id: string }[]).map((r) => r.id);
  }

  private bump(taskId: string, state: TaskState): void {
    this.db.prepare('UPDATE tasks SET state = ?, version = version + 1 WHERE id = ?').run(state, taskId);
  }

  // 총괄의 "이 작업을 실행하라" 제안. expectedVersion 은 총괄이 보고 판단한 상태 버전이다.
  async dispatch(taskId: string, expectedVersion: number, prompt: string, crashAt?: 'after_intent' | 'after_launch'): Promise<Attempt> {
    // 실행 전에 attempt ID·request_id·작업 디렉터리·시작 의도를 먼저 저장한다
    const attempt = this.tx(() => {
      const t = this.task(taskId);
      if (t.version !== expectedVersion) throw new Rejected(`상태 버전이 다르다: 현재 ${t.version}, 제안 ${expectedVersion}`);
      if (t.state !== 'ready') throw new Rejected(`실행 가능 상태가 아니다: ${t.state}`);
      const id = randomUUID();
      const a: Attempt = { id, task_id: taskId, request_id: `req-${id}`, workdir: path.join(this.workRoot, id), prompt, status: 'intent' };
      this.db.prepare('INSERT INTO attempts (id, task_id, request_id, workdir, prompt, status) VALUES (?, ?, ?, ?, ?, ?)')
        .run(a.id, a.task_id, a.request_id, a.workdir, a.prompt, a.status);
      this.bump(taskId, 'running');
      return a;
    });
    if (crashAt === 'after_intent') throw new SimulatedCrash('의도 저장 직후');
    await this.adapter.launch({ requestId: attempt.request_id, workdir: attempt.workdir, prompt: attempt.prompt });
    if (crashAt === 'after_launch') throw new SimulatedCrash('실행 직후, launched 기록 전');
    this.db.prepare(`UPDATE attempts SET status = 'launched' WHERE id = ? AND status = 'intent'`).run(attempt.id);
    return { ...attempt, status: 'launched' };
  }

  // 재시작 뒤 끝나지 않은 시도를 request_id 로 다시 조회해 이어 간다
  async recover(): Promise<void> {
    const live = this.db.prepare(`SELECT * FROM attempts WHERE status IN ('intent', 'launched') ORDER BY rowid`).all() as Attempt[];
    for (const a of live) {
      const r = await this.adapter.lookup(a.request_id);
      if (r === 'running') {
        this.setAttemptStatus(a.id, 'launched');
      } else if (r === 'succeeded' || r === 'failed') {
        this.onResult(`lookup:${a.id}`, a.id, r);
      } else if (r === 'not_found' && a.status === 'intent') {
        // 시작된 적이 없다고 어댑터가 확인해 줬으므로 같은 request_id 로 시작한다
        await this.adapter.launch({ requestId: a.request_id, workdir: a.workdir, prompt: a.prompt });
        this.setAttemptStatus(a.id, 'launched');
      } else if (a.status === 'intent' || r === 'not_found') {
        // 시작됐는지 알 수 없다. 다시 시작하지 않고 조사 대상으로 남긴다
        this.setAttemptStatus(a.id, 'launch_unknown');
      }
      // launched + unknown: 살아 있는지 확인할 수 없으므로 기다린다. 재시도하지 않는다
    }
  }

  private setAttemptStatus(attemptId: string, status: AttemptStatus): void {
    this.db.prepare('UPDATE attempts SET status = ? WHERE id = ?').run(status, attemptId);
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
      return true;
    });
  }

  openDecision(id: string): void {
    this.db.prepare(`INSERT INTO decisions (id, spec_version, status) VALUES (?, ?, 'open')`).run(id, this.specVersion());
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
    });
  }

  // 통합된 SHA 에서 검증을 통과해야 done 이 된다
  integrate(taskId: string, commitSha: string, testsPassed: boolean): void {
    this.tx(() => {
      const t = this.task(taskId);
      if (t.state !== 'integrating') throw new Rejected(`통합 단계가 아니다: ${t.state}`);
      if (testsPassed) {
        this.db.prepare(`UPDATE tasks SET state = 'done', commit_sha = ?, version = version + 1 WHERE id = ?`).run(commitSha, taskId);
      } else {
        this.bump(taskId, 'ready');
      }
    });
  }
}
