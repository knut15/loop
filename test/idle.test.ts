import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Manager, Rejected } from '../src/manager.ts';
import { FakeAdapter } from '../src/fake-adapter.ts';
import { runLoop, type Coordinator, type LoopOptions } from '../src/loop.ts';
import { llmCoordinator } from '../src/llm-coordinator.ts';

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'loop-ai-idle-'));
  const adapter = FakeAdapter.init(path.join(dir, 'fake.json'));
  adapter.autoResult = 'succeeded';
  const notes: string[] = [];
  const m = new Manager(path.join(dir, 'state.db'), adapter, path.join(dir, 'work'), (r) => notes.push(r));
  return { dir, adapter, m, notes };
}
const opts = (o: Partial<LoopOptions>): LoopOptions => ({ integrator: async () => ({ passed: true, sha: 's' }), maxConcurrent: 2, intervalMs: 1, maxTicks: 10, ...o });

test('I1. 실행 가능한 작업이 있는데 총괄이 아무것도 내지 않으면 진행이 멈췄다고 한 번 알린다', async () => {
  const s = setup();
  s.m.addTask('stale', { prompt: 'x' });
  const silent: Coordinator = { decidesCompletion: true, propose: () => ({ proposals: [], goalComplete: true }) };
  const r = await runLoop(s.m, opts({ coordinator: silent }));
  assert.equal(r.status, 'max_ticks');
  const alerted = s.m.history(80).filter((h) => h.kind === 'alerted' && /진행이 멈췄다: 끝나지 않은 작업 1개\(stale:ready\)/.test(h.detail));
  assert.equal(alerted.length, 1);
});

test('I2. 총괄이 필요 없는 작업을 취소하면 완료로 치고, 인수 검증을 거쳐 끝난다', async () => {
  const s = setup();
  s.m.addTask('old-plan', { prompt: 'x', dependsOn: [] });
  s.m.addTask('real', { prompt: 'y' });
  s.m.cancelTask('real', '테스트 준비'); // 섞인 상태를 만들기 위해 하나는 먼저 치운다
  let calls = 0;
  const coordinator = llmCoordinator(async () => {
    calls++;
    return calls === 1
      ? { reasoning: 'r', goal_complete: false, proposals: [{ kind: 'cancel_task', task_id: 'old-plan', prompt: 'replaced by real', depends_on: null, blocked_by: null, expected_version: null, decision_id: null, question: null, role: null, verify: null }] }
      : { reasoning: 'r', goal_complete: true, proposals: [] };
  });
  let accepted = 0;
  const r = await runLoop(s.m, opts({ coordinator, accept: { command: 'true', run: () => { accepted++; return { passed: true, output: '' }; } } }));
  assert.equal(r.status, 'done');
  assert.equal(s.m.task('old-plan').state, 'cancelled');
  assert.equal(accepted, 1);
  assert.ok(s.m.history(40).some((h) => h.kind === 'cancelled' && /총괄이 취소: replaced by real/.test(h.detail)));
});

test('I3. 돌고 있거나 끝난 작업은 취소할 수 없고, CLI 로 ready 작업을 취소한다', async () => {
  const s = setup();
  s.adapter.autoResult = undefined;
  s.m.addTask('t', { prompt: 'x' });
  await s.m.dispatch('t', 0, 'x');
  assert.throws(() => s.m.cancelTask('t', 'no'), Rejected);

  const dir = mkdtempSync(path.join(tmpdir(), 'loop-ai-cancel-cli-'));
  const cli = path.join(import.meta.dirname, '..', 'src', 'cli.ts');
  const run = (...a: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, ...a], { encoding: 'utf8' });
  assert.equal(run('init', dir, '--adapter', 'fake').status, 0);
  assert.equal(run('add', dir, 'a', '--prompt', 'A').status, 0);
  assert.match(run('cancel', dir, 'a', '계획이', '바뀜').stdout, /작업 취소: a/);
  assert.match(run('status', dir).stdout, /\| a \| cancelled \|/);
  assert.equal(run('cancel', dir, 'a').status, 1);
});
