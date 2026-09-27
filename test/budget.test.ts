import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Manager } from '../src/manager.ts';
import { FakeAdapter } from '../src/fake-adapter.ts';
import { tick, type Integrator, type LoopOptions } from '../src/loop.ts';

function setup(clock: { t: number }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'loop-ai-budget-'));
  const adapter = FakeAdapter.init(path.join(dir, 'fake.json'));
  adapter.autoResult = 'succeeded';
  const notes: string[] = [];
  const m = new Manager(path.join(dir, 'state.db'), adapter, path.join(dir, 'work'), (r) => notes.push(r), { now: () => clock.t });
  return { adapter, m, notes };
}
const pass: Integrator = async () => ({ passed: true, sha: 's' });

test('B1. 작업자 사용량을 시도마다 한 번 기록하고, 비용 상한에 닿으면 새 작업을 멈추고 한 번 알린다', async () => {
  const clock = { t: 0 };
  const s = setup(clock);
  for (const id of ['a', 'b', 'c']) s.m.addTask(id, { prompt: id });
  s.m.setBudget({ maxCostUsd: 0.05 });
  const opts: LoopOptions = { integrator: pass, maxConcurrent: 1, intervalMs: 1, readUsage: () => ({ costUsd: 0.03, inputTokens: 10, outputTokens: 5 }) };
  for (let i = 0; i < 8; i++) await tick(s.m, opts);
  // a($0.03) 뒤 b($0.06 누적)가 끝나면 상한을 넘는다. c 는 시작하지 않는다
  assert.equal(s.m.task('a').state, 'done');
  assert.equal(s.m.task('b').state, 'done');
  assert.equal(s.m.attempts('c').length, 0);
  const t = s.m.usageTotals();
  assert.equal(t.costKnown, 2);
  assert.ok(Math.abs(t.costUsd - 0.06) < 1e-9);
  const alerted = s.m.history(80).filter((h) => h.kind === 'alerted' && /예산을 넘어 새 작업을 멈췄다/.test(h.detail));
  assert.equal(alerted.length, 1);
  assert.match(s.m.report(), /## 사용량[\s\S]*기록된 비용: \$0\.0600 \(2회\)/);

  // 예산을 늘리면 알림이 내려가고 이어서 돈다
  s.m.setBudget({ maxCostUsd: 1 });
  for (let i = 0; i < 4; i++) await tick(s.m, opts);
  assert.equal(s.m.task('c').state, 'done');
  assert.equal(s.m.attention().length, 0);
});

test('B2. 경과 시간 상한에 닿으면 새 작업을 내지 않는다. 돌고 있는 작업자는 그대로 둔다', async () => {
  const clock = { t: 1_000_000 };
  const s = setup(clock);
  s.adapter.autoResult = undefined;
  s.m.addTask('run', { prompt: 'r' });
  s.m.addTask('wait', { prompt: 'w' });
  s.m.setBudget({ maxMinutes: 10 });
  const opts: LoopOptions = { integrator: pass, maxConcurrent: 1, intervalMs: 1 };
  await tick(s.m, opts);
  assert.equal(s.m.liveCount(), 1);
  clock.t += 11 * 60_000;
  const [a] = s.m.attempts('run');
  s.adapter.finish(a!.request_id, 'succeeded');
  for (let i = 0; i < 3; i++) await tick(s.m, opts);
  assert.equal(s.m.task('run').state, 'done'); // 돌던 작업은 끝까지 반영된다
  assert.equal(s.m.attempts('wait').length, 0); // 새 작업은 내지 않았다
  assert.match(s.notes.at(-1)!, /경과 시간 11분이 상한 10분에 닿았다/);
});

test('B3. 비용을 모르는 호출(Codex)은 따로 세고, 비용 상한 판정에서 빠졌다고 알린다', () => {
  const s = setup({ t: 0 });
  s.m.recordUsage('worker', { costUsd: null, inputTokens: 100, outputTokens: 10 });
  s.m.recordUsage('coordinator', { costUsd: 0.2 });
  s.m.setBudget({ maxCostUsd: 0.1 });
  const t = s.m.usageTotals();
  assert.deepEqual([t.costKnown, t.costUnknown, t.inputTokens], [1, 1, 100]);
  assert.match(s.m.budgetExceeded()!, /비용을 모르는 호출 1건은 빠져 있다/);
  assert.match(s.m.report(), /비용을 모르는 호출: 1회/);
});
