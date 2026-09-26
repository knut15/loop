import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Manager, SimulatedCrash } from '../src/manager.ts';
import { FakeAdapter } from '../src/fake-adapter.ts';
import type { Adapter, LookupResult } from '../src/adapter.ts';

// Codex 코드 검토에서 재현된 문제의 회귀 테스트

function setup(notify?: (r: string) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), 'loop-ai-fix-'));
  const adapter = FakeAdapter.init(path.join(dir, 'fake.json'));
  const dbPath = path.join(dir, 'state.db');
  const m = new Manager(dbPath, adapter, path.join(dir, 'work'), notify ?? (() => {}));
  return { dir, dbPath, adapter, m };
}

test('R1. 알림 전달이 실패하면 보낸 것으로 기록하지 않고 다음에 다시 보낸다', () => {
  let fail = true;
  const delivered: string[] = [];
  const s = setup((r) => {
    if (fail) throw new Error('delivery failed');
    delivered.push(r);
  });
  s.m.openDecision('d'); // 여기서 알림이 실패해도 결정 요청 자체는 남아야 한다
  assert.equal(s.m.hasDecision('d'), true);
  assert.equal(delivered.length, 0);
  assert.ok(s.m.history().some((h) => h.kind === 'alert_failed'));
  assert.equal(s.m.alertIfNeeded(), false); // 여전히 실패
  fail = false;
  assert.equal(s.m.alertIfNeeded(), true); // 전달되면 그때 보낸 것으로 기록
  assert.equal(delivered.length, 1);
  assert.equal(s.m.alertIfNeeded(), false);
});

test('R2. recover 를 동시에 두 번 불러도 같은 request_id 를 두 번 시작하지 않는다', async () => {
  const s = setup();
  s.m.addTask('t1');
  await assert.rejects(s.m.dispatch('t1', 0, 'build', 'after_intent'), SimulatedCrash);
  await Promise.all([s.m.recover(), s.m.recover()]);
  assert.equal(s.adapter.totalLaunches(), 1);
});

test('R2-1. dispatch 와 recover 가 겹쳐도 시작은 한 번이다', async () => {
  const s = setup();
  s.m.addTask('t1');
  await Promise.all([s.m.dispatch('t1', 0, 'build'), s.m.recover(), s.m.recover()]);
  assert.equal(s.adapter.totalLaunches(), 1);
});

test('R3. launch_unknown 도 계속 조회해, 확실한 근거가 나오면 반영한다. 다시 시작하지는 않는다', async () => {
  const s = setup();
  s.m.addTask('t1');
  await assert.rejects(s.m.dispatch('t1', 0, 'build', 'after_launch'), SimulatedCrash);
  s.adapter.canLookup = false;
  await s.m.recover();
  const [a] = s.m.attempts('t1');
  assert.equal(a!.status, 'launch_unknown');
  s.adapter.canLookup = true;
  s.adapter.finish(a!.request_id, 'succeeded');
  await s.m.recover();
  assert.equal(s.m.attempts('t1')[0]!.status, 'succeeded');
  assert.equal(s.m.task('t1').state, 'integrating');
  assert.equal(s.adapter.totalLaunches(), 1);
});

test('R3-1. launch_unknown 에서 not_found 가 와도 다시 시작하지 않는다', async () => {
  const s = setup();
  s.m.addTask('t1');
  await assert.rejects(s.m.dispatch('t1', 0, 'build', 'after_intent'), SimulatedCrash);
  s.adapter.canLookup = false;
  await s.m.recover();
  assert.equal(s.m.attempts('t1')[0]!.status, 'launch_unknown');
  s.adapter.canLookup = true; // 저장소에 기록이 없으므로 not_found
  await s.m.recover();
  assert.equal(s.m.attempts('t1')[0]!.status, 'launch_unknown');
  assert.equal(s.adapter.totalLaunches(), 0);
});

test('R4. 이전 스키마의 DB 를 열면 없는 열을 추가하고 기존 기록을 살린다', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'loop-ai-mig-'));
  const dbPath = path.join(dir, 'state.db');
  const old = new DatabaseSync(dbPath);
  old.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, state TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, blocked_by TEXT, commit_sha TEXT);
    CREATE TABLE attempts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
      request_id TEXT NOT NULL UNIQUE, workdir TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE events (key TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, result TEXT NOT NULL);
    CREATE TABLE decisions (id TEXT PRIMARY KEY, spec_version INTEGER NOT NULL, status TEXT NOT NULL, answer TEXT);
    INSERT INTO tasks (id, state, version) VALUES ('old', 'ready', 4);
  `);
  old.close();
  const m = new Manager(dbPath, FakeAdapter.init(path.join(dir, 'fake.json')), path.join(dir, 'work'), () => {});
  assert.equal(m.task('old').version, 4);
  assert.equal(m.task('old').max_attempts, 3);
  m.addTask('new', { prompt: 'P', dependsOn: ['old'] });
  assert.deepEqual(m.runnable(), ['old']);
  await m.dispatch('old', 4, 'P');
  await m.recover();
  assert.equal(m.attempts('old')[0]!.status, 'launched');
});

test('R5. 조회를 기다리는 사이 다른 쪽이 결과를 반영하면 recover 가 그것을 덮어쓰지 않는다', async () => {
  const s = setup();
  s.m.addTask('t1');
  const a = await s.m.dispatch('t1', 0, 'build');
  const other = new Manager(s.dbPath, s.adapter, path.join(s.dir, 'work'), () => {});
  const slow: Adapter = {
    launch: (r) => s.adapter.launch(r),
    async lookup(id): Promise<LookupResult> {
      other.onResult('evt-concurrent', a.id, 'failed'); // 조회 도중 다른 프로세스가 실패를 반영
      return 'running';
    },
  };
  const m = new Manager(s.dbPath, slow, path.join(s.dir, 'work'), () => {});
  await m.recover();
  assert.equal(m.attempts('t1')[0]!.status, 'failed');
  assert.equal(m.task('t1').state, 'ready');
});
