import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Manager } from '../src/manager.ts';
import { FakeAdapter } from '../src/fake-adapter.ts';
import { runLoop, settleJobs, tick, type Integrator, type LoopOptions } from '../src/loop.ts';
import type { IntegrationResult } from '../src/workspace.ts';

// 검증을 tick 과 따로 돌린다. 오래 걸리거나 멈춘 검증 명령이 루프 전체를 세우지 않게 한다

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'loop-ai-bg-'));
  const adapter = FakeAdapter.init(path.join(dir, 'fake.json'));
  adapter.autoResult = 'succeeded';
  const m = new Manager(path.join(dir, 'state.db'), adapter, path.join(dir, 'work'), () => {});
  return { dir, adapter, m };
}

// 손으로 끝낼 수 있는 통합기. 부르면 기다리다가 release() 를 부르면 통과로 끝난다
function gated() {
  let release!: () => void;
  const opened = new Promise<void>((r) => { release = r; });
  const calls: string[] = [];
  const integrator: Integrator = async (t) => { calls.push(t.id); await opened; return { passed: true, sha: 's' } satisfies IntegrationResult; };
  return { integrator, release, calls };
}

test('V1. 통합 검증이 도는 동안에도 tick 은 기다리지 않고 다른 작업을 dispatch 한다', async () => {
  const s = setup();
  const g = gated();
  s.m.addTask('a', { prompt: 'a' });
  s.m.addTask('b', { prompt: 'b' });
  const opts: LoopOptions = { integrator: g.integrator, maxConcurrent: 1, intervalMs: 1, backgroundVerify: true };
  await tick(s.m, opts); // a dispatch
  await tick(s.m, opts); // a 는 integrating → 검증 시작. 기다리지 않고 b 를 dispatch 한다
  await tick(s.m, opts);
  assert.equal(s.m.task('a').state, 'integrating');
  assert.deepEqual(g.calls, ['a'], '도는 검증이 있으면 같은 작업을 다시 시작하지 않는다');
  assert.equal(s.m.attempts('b').length, 1, 'a 의 검증을 기다리지 않고 b 를 냈다');
  g.release();
  await settleJobs(s.m);
  assert.equal(s.m.task('a').state, 'done');
});

test('V2. 따로 돈 검증에서 난 예외는 삼키지 않고 다음 tick 에서 던진다. runLoop 는 검증이 끝난 뒤 돌려준다', async () => {
  const s = setup();
  s.m.addTask('a', { prompt: 'a' });
  const boom: Integrator = async () => { throw new Error('integration crashed'); };
  const opts: LoopOptions = { integrator: boom, maxConcurrent: 1, intervalMs: 1, backgroundVerify: true };
  await tick(s.m, opts);
  await tick(s.m, opts);
  await new Promise((r) => setImmediate(r));
  await assert.rejects(tick(s.m, opts), /integration crashed/);

  const t = setup();
  const g = gated();
  t.m.addTask('x', { prompt: 'x' });
  setTimeout(() => g.release(), 50);
  const r = await runLoop(t.m, { integrator: g.integrator, maxConcurrent: 1, intervalMs: 5, maxTicks: 200, backgroundVerify: true });
  assert.equal(r.status, 'done');
  assert.equal(t.m.task('x').state, 'done');
});
