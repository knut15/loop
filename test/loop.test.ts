import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Manager } from '../src/manager.ts';
import { FakeAdapter } from '../src/fake-adapter.ts';
import { runLoop, tick, type Integrator, type LoopOptions } from '../src/loop.ts';

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'loop-ai-loop-'));
  const adapter = FakeAdapter.init(path.join(dir, 'fake.json'));
  const notes: string[] = [];
  const m = new Manager(path.join(dir, 'state.db'), adapter, path.join(dir, 'work'), (r) => notes.push(r));
  return { dir, adapter, m, notes };
}

const pass: Integrator = async () => ({ passed: true, sha: 'sha-ok' });
const opts = (o: Partial<LoopOptions> = {}): LoopOptions => ({ integrator: pass, maxConcurrent: 2, intervalMs: 1, ...o });

test('L1. 의존관계 순서대로 끝까지 돌고 done 으로 끝난다', async () => {
  const s = setup();
  s.adapter.autoResult = 'succeeded';
  s.m.addTask('a', { prompt: 'A' });
  s.m.addTask('b', { prompt: 'B', dependsOn: ['a'] });
  s.m.addTask('c', { prompt: 'C', dependsOn: ['b'] });
  const r = await runLoop(s.m, opts({ maxTicks: 20 }));
  assert.equal(r.status, 'done');
  assert.deepEqual(s.m.tasks().map((t) => t.state), ['done', 'done', 'done']);
  // b 는 a 가 done 이 된 뒤에야 시작됐다
  const h = s.m.history().map((x) => `${x.task_id}:${x.kind}`);
  assert.ok(h.indexOf('a:done') < h.indexOf('b:intent'));
  assert.ok(h.indexOf('b:done') < h.indexOf('c:intent'));
  assert.equal(s.adapter.totalLaunches(), 3);
});

test('L2. 동시 실행 상한을 넘지 않는다', async () => {
  const s = setup();
  for (const id of ['a', 'b', 'c', 'd']) s.m.addTask(id, { prompt: id });
  await tick(s.m, opts({ maxConcurrent: 2 }));
  assert.equal(s.m.liveCount(), 2);
  assert.equal(s.adapter.totalLaunches(), 2);
  await tick(s.m, opts({ maxConcurrent: 2 })); // 아무것도 안 끝났으니 더 띄우지 않는다
  assert.equal(s.adapter.totalLaunches(), 2);
  const [a] = s.m.attempts('a');
  s.adapter.finish(a!.request_id, 'succeeded');
  await tick(s.m, opts({ maxConcurrent: 2 }));
  assert.equal(s.m.task('a').state, 'done');
  assert.equal(s.adapter.totalLaunches(), 3);
  assert.equal(s.m.liveCount(), 2);
});

test('L3. 작업자가 조용히 사라져도 다른 작업은 끝까지 가고, 멈춘 작업은 한 번 알린 채 기다린다', async () => {
  const s = setup();
  s.m.addTask('stuck', { prompt: 'X' });
  s.m.addTask('ok', { prompt: 'Y' });
  await tick(s.m, opts());
  const [stuck] = s.m.attempts('stuck');
  s.adapter.unreachable.add(stuck!.request_id);
  const [ok] = s.m.attempts('ok');
  s.adapter.finish(ok!.request_id, 'succeeded');
  const r = await runLoop(s.m, opts({ maxTicks: 5 }));
  assert.equal(r.status, 'max_ticks'); // 멈춘 작업이 있어도 끝내지 않고 계속 돈다
  assert.equal(s.m.task('ok').state, 'done');
  assert.equal(s.m.task('stuck').state, 'running');
  assert.equal(s.notes.length, 1);
  assert.match(s.notes[0]!, /종료 코드 없이 사라졌거나/);
  assert.equal(s.m.attempts('stuck').length, 1); // 재시도하지 않았다
});

test('L4. 사용자 응답이 다른 프로세스에서 들어오면 다음 tick 에서 이어 간다', async () => {
  const s = setup();
  s.adapter.autoResult = 'succeeded';
  s.m.openDecision('db');
  s.m.addTask('schema', { prompt: 'S', blockedBy: 'db' });
  const ac = new AbortController();
  const loop = runLoop(s.m, opts({ intervalMs: 20, signal: ac.signal }));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(s.m.task('schema').state, 'blocked');
  // CLI 의 answer 명령처럼 같은 DB 를 연 별도 Manager 가 응답을 쓴다
  const other = new Manager(path.join(s.dir, 'state.db'), s.adapter, path.join(s.dir, 'work'));
  other.answerDecision('db', 1, 'PostgreSQL');
  other.close();
  const r = await loop;
  assert.equal(r.status, 'done');
  assert.equal(s.m.task('schema').state, 'done');
  ac.abort();
});

test('L5. 통합 검증이 계속 실패하면 시도 상한에서 멈추고 알린다', async () => {
  const s = setup();
  s.adapter.autoResult = 'succeeded';
  s.m.addTask('flaky', { prompt: 'F', maxAttempts: 2 });
  const fail: Integrator = async () => ({ passed: false, sha: 'sha-bad' });
  const r = await runLoop(s.m, opts({ integrator: fail, maxTicks: 10 }));
  assert.equal(r.status, 'max_ticks');
  assert.equal(s.m.attempts('flaky').length, 2);
  assert.equal(s.m.task('flaky').state, 'ready');
  assert.deepEqual(s.m.runnable(), []);
  assert.equal(s.notes.length, 1);
  assert.match(s.notes[0]!, /2번 시도했지만/);
  assert.match(s.notes[0]!, /grantAttempts\('flaky', 1\)/);

  // 사람이 원인을 고치고 한 번 더 허용하면 이어서 돈다
  s.m.grantAttempts('flaky', 1);
  const r2 = await runLoop(s.m, opts({ maxTicks: 10 }));
  assert.equal(r2.status, 'done');
  assert.equal(s.m.attempts('flaky').length, 3);
});

test('L6. 중단 신호를 받으면 stopped 로 끝나고, 다시 돌리면 이어 간다', async () => {
  const s = setup();
  s.m.addTask('a', { prompt: 'A' });
  const ac = new AbortController();
  const loop = runLoop(s.m, opts({ intervalMs: 50, signal: ac.signal }));
  await new Promise((r) => setTimeout(r, 20));
  ac.abort();
  assert.equal((await loop).status, 'stopped');
  const [a] = s.m.attempts('a');
  s.adapter.finish(a!.request_id, 'succeeded');
  assert.equal((await runLoop(s.m, opts({ maxTicks: 5 }))).status, 'done');
  assert.equal(s.adapter.totalLaunches(), 1);
});

test('L7. CLI 로 init → add → run → status 가 끝까지 돈다', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'loop-ai-cli-'));
  const cli = path.join(import.meta.dirname, '..', 'src', 'cli.ts');
  const run = (...args: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, ...args], { encoding: 'utf8' });
  assert.equal(run('init', dir, '--adapter', 'fake').status, 0);
  assert.equal(run('add', dir, 'a', '--prompt', 'A').status, 0);
  assert.equal(run('add', dir, 'b', '--prompt', 'B', '--after', 'a').status, 0);
  const r = run('run', dir, '--verify', 'true', '--interval', '10');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /루프 종료: done/);
  const status = run('status', dir);
  assert.match(status.stdout, /\| a \| done \|/);
  assert.match(status.stdout, /\| b \| done \|/);
  assert.ok(existsSync(path.join(dir, '.loop-ai', 'STATUS.md')));
  assert.match(readFileSync(path.join(dir, '.loop-ai', 'STATUS.md'), 'utf8'), /모든 작업이 끝났다/);
  // 검증 명령 없이 run 하면 거절한다
  assert.equal(run('run', dir).status, 1);
});
