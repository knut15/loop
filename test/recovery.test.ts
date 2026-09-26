import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { Manager, Rejected, SimulatedCrash } from '../src/manager.ts';
import { FakeAdapter } from '../src/fake-adapter.ts';

// 합의안 표 7 의 장애 주입 시나리오.
// restart() 는 같은 프로세스 안에서 Manager 와 FakeAdapter 를 파일로부터 새로 만드는 객체 재생성이다.
// 실제 프로세스를 죽였다 다시 띄우는 검증은 11번 테스트가 따로 한다.
function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'loop-ai-'));
  const dbPath = path.join(dir, 'state.db');
  const storePath = path.join(dir, 'fake-adapter.json');
  let adapter = FakeAdapter.init(storePath);
  let m = new Manager(dbPath, adapter, path.join(dir, 'work'));
  return {
    dir,
    storePath,
    get adapter() { return adapter; },
    get m() { return m; },
    restart() {
      m.close();
      adapter = new FakeAdapter(storePath);
      m = new Manager(dbPath, adapter, path.join(dir, 'work'));
      return m;
    },
  };
}

test('1. 총괄이 재시작 뒤 오래된 제안을 다시 보내도 시도는 1개다', async () => {
  const s = setup();
  s.m.addTask('t1');
  await s.m.dispatch('t1', 0, 'build');
  // 재시작한 총괄이 이전 스냅샷(version 0)으로 같은 제안을 다시 낸다
  await assert.rejects(s.m.dispatch('t1', 0, 'build'), Rejected);
  assert.equal(s.m.attempts('t1').length, 1);
  assert.equal(s.adapter.totalLaunches(), 1);
});

test('2. 같은 완료 이벤트를 두 번 받아도 상태 전이는 한 번이다', async () => {
  const s = setup();
  s.m.addTask('t1');
  const a = await s.m.dispatch('t1', 0, 'build');
  const before = s.m.task('t1').version;
  assert.equal(s.m.onResult('evt-1', a.id, 'succeeded'), true);
  assert.equal(s.m.onResult('evt-1', a.id, 'succeeded'), false);
  assert.equal(s.m.task('t1').state, 'integrating');
  assert.equal(s.m.task('t1').version, before + 1);
});

test('3. 작업자 생존을 확인할 수 없으면 새 시도를 내지 않고, 실패가 확인된 뒤에만 재시도한다', async () => {
  const s = setup();
  s.m.addTask('t1');
  const a = await s.m.dispatch('t1', 0, 'build');
  const m = s.restart();
  s.adapter.unreachable.add(a.request_id);
  await m.recover();
  assert.equal(m.attempts('t1')[0]!.status, 'launched');
  assert.equal(m.task('t1').state, 'running');
  await assert.rejects(m.dispatch('t1', m.task('t1').version, 'build'), Rejected);
  assert.equal(s.adapter.totalLaunches(), 1);

  // 실패가 확인되면 그때 재시도할 수 있다
  m.onResult('evt-fail', a.id, 'failed');
  const retry = await m.dispatch('t1', m.task('t1').version, 'build');
  assert.notEqual(retry.request_id, a.request_id);
  assert.equal(s.adapter.totalLaunches(), 2);
});

test('4. 사용자 결정을 기다리는 동안 관련 없는 작업은 끝까지 진행된다', async () => {
  const s = setup();
  s.m.openDecision('d1');
  s.m.addTask('t1', 'd1');
  s.m.addTask('t2');
  assert.deepEqual(s.m.runnable(), ['t2']);
  const a = await s.m.dispatch('t2', 0, 'build');
  s.m.onResult('evt-t2', a.id, 'succeeded');
  s.m.integrate('t2', 'sha-t2', true);
  assert.equal(s.m.task('t2').state, 'done');
  assert.equal(s.m.task('t1').state, 'blocked');
});

test('5. 관리자가 재시작해도 완료된 작업은 다시 돌지 않는다', async () => {
  const s = setup();
  s.m.addTask('t1');
  const a = await s.m.dispatch('t1', 0, 'build');
  s.m.onResult('evt-1', a.id, 'succeeded');
  s.m.integrate('t1', 'sha-1', true);
  const m = s.restart();
  await m.recover();
  assert.equal(m.task('t1').state, 'done');
  assert.deepEqual(m.runnable(), []);
  assert.equal(s.adapter.totalLaunches(), 1);
});

test('6. 상태 저장 뒤 실행 응답을 잃어도 request_id 로 조회해 중복 없이 이어 간다', async () => {
  const s = setup();
  s.m.addTask('t1');
  s.m.addTask('t2');
  // t1: 실행은 됐는데 launched 를 기록하기 전에 죽었다
  await assert.rejects(s.m.dispatch('t1', 0, 'build', 'after_launch'), SimulatedCrash);
  // t2: 의도만 저장하고 실행 전에 죽었다
  await assert.rejects(s.m.dispatch('t2', 0, 'build', 'after_intent'), SimulatedCrash);
  const m = s.restart();
  await m.recover();
  const [a1] = m.attempts('t1');
  const [a2] = m.attempts('t2');
  assert.equal(a1!.status, 'launched');
  assert.equal(s.adapter.launchCount(a1!.request_id), 1);
  // 시작된 적 없다고 확인된 t2 는 같은 request_id 로 한 번 시작된다
  assert.equal(a2!.status, 'launched');
  assert.equal(s.adapter.launchCount(a2!.request_id), 1);
});

test('6-1. 어댑터가 실행을 기록한 뒤 응답 전에 throw 해도 재조회로 이어 가고 다시 시작하지 않는다', async () => {
  const s = setup();
  s.m.addTask('t1');
  s.adapter.throwAfterRecord = true;
  await assert.rejects(s.m.dispatch('t1', 0, 'build'));
  s.adapter.throwAfterRecord = false;
  assert.equal(s.m.attempts('t1')[0]!.status, 'intent');
  await s.m.recover();
  const [a] = s.m.attempts('t1');
  assert.equal(a!.status, 'launched');
  assert.equal(s.adapter.launchCount(a!.request_id), 1);
});

test('6-2. 어댑터 기록을 잃으면 not_found 가 아니라 unknown 으로 보고 다시 시작하지 않는다', async () => {
  const s = setup();
  s.m.addTask('t1');
  await assert.rejects(s.m.dispatch('t1', 0, 'build', 'after_launch'), SimulatedCrash);
  rmSync(s.storePath);
  const m = s.restart();
  await m.recover();
  assert.equal(m.attempts('t1')[0]!.status, 'launch_unknown');
  // 저장소가 없으므로 launch 가 불렸다면 throw 했을 것이다. 저장소도 새로 생기지 않았다
  assert.equal(existsSync(s.storePath), false);
});

test('7. 실행 직후 죽었는데 어댑터로 조회할 수 없으면 launch_unknown 으로 남고 다시 시작하지 않는다', async () => {
  const s = setup();
  s.m.addTask('t1');
  await assert.rejects(s.m.dispatch('t1', 0, 'build', 'after_launch'), SimulatedCrash);
  const m = s.restart();
  s.adapter.canLookup = false;
  await m.recover();
  await m.recover(); // 두 번 복구해도 같다
  assert.equal(m.attempts('t1')[0]!.status, 'launch_unknown');
  assert.equal(s.adapter.totalLaunches(), 1);
  await assert.rejects(m.dispatch('t1', m.task('t1').version, 'build'), Rejected);
});

test('8. 중복 사용자 응답과 오래된 스펙에 대한 응답은 거절한다', () => {
  const s = setup();
  s.m.openDecision('d1');
  s.m.addTask('t1', 'd1');
  s.m.answerDecision('d1', 1, 'PostgreSQL');
  assert.equal(s.m.task('t1').state, 'ready');
  assert.throws(() => s.m.answerDecision('d1', 1, 'MySQL'), Rejected);

  s.m.openDecision('d2');
  s.m.setSpecVersion(2);
  assert.throws(() => s.m.answerDecision('d2', 1, 'yes'), Rejected);
});

test('9. 통합 뒤 테스트가 실패하면 done 이 되지 않는다', async () => {
  const s = setup();
  s.m.addTask('t1');
  const a = await s.m.dispatch('t1', 0, 'build');
  s.m.onResult('evt-1', a.id, 'succeeded');
  s.m.integrate('t1', 'sha-bad', false);
  assert.equal(s.m.task('t1').state, 'ready');
  assert.equal(s.m.task('t1').commit_sha, null);
});

function startHolder(lockPath: string): { child: ChildProcess; line: Promise<string>; exit: Promise<number | null> } {
  const fixture = path.join(import.meta.dirname, 'fixtures', 'hold-lock.ts');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', fixture, lockPath]);
  const line = new Promise<string>((resolve) => child.stdout!.once('data', (d) => resolve(String(d).trim())));
  const exit = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, line, exit };
}

test('10. 관리자를 두 번 띄우면 두 번째는 시작 단계에서 거절되고, 첫 번째가 죽으면 잠금이 풀린다', async () => {
  const lockPath = path.join(setup().dir, 'manager.lock');
  const first = startHolder(lockPath);
  assert.equal(await first.line, 'ACQUIRED');

  const second = startHolder(lockPath);
  assert.equal(await second.line, 'REJECTED');
  assert.equal(await second.exit, 3);

  first.child.kill('SIGKILL');
  await first.exit;
  const third = startHolder(lockPath);
  assert.equal(await third.line, 'ACQUIRED');
  third.child.kill('SIGKILL');
  await third.exit;
});

function runCrashChild(dir: string, crashAt: string): Promise<number | null> {
  const fixture = path.join(import.meta.dirname, 'fixtures', 'crash-dispatch.ts');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', fixture, dir, crashAt]);
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve(signal ? null : code)));
}

test('11. 관리자 프로세스를 실제로 SIGKILL 한 뒤 새 프로세스가 중복 없이 이어 간다', async () => {
  for (const crashAt of ['after_intent', 'after_launch']) {
    const dir = mkdtempSync(path.join(tmpdir(), 'loop-ai-proc-'));
    FakeAdapter.init(path.join(dir, 'fake-adapter.json'));
    // 자식이 dispatch 도중 스스로 SIGKILL 로 죽는다. 종료 코드 대신 시그널로 끝나야 한다
    assert.equal(await runCrashChild(dir, crashAt), null, crashAt);
    const adapter = new FakeAdapter(path.join(dir, 'fake-adapter.json'));
    const m = new Manager(path.join(dir, 'state.db'), adapter, path.join(dir, 'work'));
    await m.recover();
    const attempts = m.attempts('t1');
    assert.equal(attempts.length, 1, crashAt);
    assert.equal(attempts[0]!.status, 'launched', crashAt);
    assert.equal(adapter.launchCount(attempts[0]!.request_id), 1, crashAt);
    m.close();
  }
});
