import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Manager, Rejected } from '../src/manager.ts';
import { FakeAdapter } from '../src/fake-adapter.ts';
import { runLoop, type LoopOptions } from '../src/loop.ts';
import { buildPrompt, llmCoordinator } from '../src/llm-coordinator.ts';
import { runVerify, sandboxAvailable } from '../src/verify.ts';
import type { ReviewInput, Reviewer } from '../src/reviewer.ts';

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'loop-ai-rounds-'));
  const adapter = FakeAdapter.init(path.join(dir, 'fake.json'));
  adapter.autoResult = 'succeeded';
  const m = new Manager(path.join(dir, 'state.db'), adapter, path.join(dir, 'work'), () => {});
  return { dir, adapter, m };
}
const base = (o: Partial<LoopOptions>): LoopOptions => ({ integrator: async () => ({ passed: true, sha: 's' }), maxConcurrent: 1, intervalMs: 1, maxTicks: 20, ...o });

test('X1. 검토 전에 작업별 검증을 돌려 그 결과를 검토자에게 증거로 준다', async () => {
  const s = setup();
  s.m.addTask('t', { prompt: 'p' });
  const seen: ReviewInput[] = [];
  const reviewer: Reviewer = async (i) => { seen.push(i); return { approve: true, issues: [], summary: 'ok' }; };
  await runLoop(s.m, base({ reviewer, preCheck: () => ({ passed: true, output: '4 passed' }) }));
  assert.equal(seen[0]!.evidence, 'PASSED: 4 passed');
});

test('X2. 같은 작업이 연달아 반려되면 두 번째 검토자가 첫 검토자의 이유와 증거를 보고 판정한다', async () => {
  const s = setup();
  s.m.addTask('t', { prompt: 'p' });
  const calls: ReviewInput[] = [];
  // 첫 검토자는 늘 반려하고, 두 번째 검토자(priorIssues 가 있는 호출)는 승인한다
  const reviewer: Reviewer = async (i) => {
    calls.push(i);
    return i.priorIssues ? { approve: true, issues: [], summary: 'issues are not real' } : { approve: false, issues: ['show test output'], summary: 'no evidence' };
  };
  const r = await runLoop(s.m, base({ reviewer, preCheck: () => ({ passed: true, output: '' }) }));
  assert.equal(r.status, 'done');
  assert.equal(s.m.attempts('t').length, 2, '첫 반려 뒤 한 번 다시 돌고, 두 번째 반려에서 두 번째 검토자가 판정했다');
  assert.equal(calls.filter((c) => c.priorIssues).length, 1);
  assert.match(calls.find((c) => c.priorIssues)!.priorIssues!, /show test output/);
  assert.ok(s.m.history(50).some((h) => /두 번째 검토자 승인/.test(h.detail)));
});

test('X3. 작업별 요약에 시도 횟수와 마지막 반려·재작업 이유가 남고, 총괄 프롬프트에 들어간다', async () => {
  const s = setup();
  s.m.addTask('t', { prompt: 'p', maxAttempts: 1 });
  const reviewer: Reviewer = async () => ({ approve: false, issues: ['missing cancel()'], summary: 'incomplete' });
  await runLoop(s.m, base({ reviewer, maxTicks: 4 }));
  const n = s.m.taskNotes().t!;
  assert.equal(n.attempts, 1);
  assert.match(n.lastRejection!, /missing cancel\(\)/);
  assert.match(n.lastRework!, /검토 반려: incomplete/);
  const prompt = buildPrompt({ goal: 'g', tasks: s.m.tasks(), runnable: [], capacity: 1, attempts: {}, decisions: [], history: [], outputs: {}, notes: s.m.taskNotes(), specVersion: 1 });
  assert.match(prompt, /"lastRejection": ".*missing cancel/);
});

test('X4. goal 이 바뀌면 스펙 버전이 오르고, 옛 작업과 옛 스펙에 대한 응답을 알아볼 수 있다', () => {
  const s = setup();
  s.m.setGoal('v1 goal');
  s.m.openDecision('db', 'which db?');
  s.m.addTask('old', { prompt: 'p' });
  s.m.setGoal('v1 goal'); // 같은 goal 은 버전을 올리지 않는다
  assert.equal(s.m.specVersion(), 1);
  s.m.setGoal('v2 goal');
  assert.equal(s.m.specVersion(), 2);
  s.m.addTask('new', { prompt: 'p' });
  assert.equal(s.m.task('old').spec_version, 1);
  assert.equal(s.m.task('new').spec_version, 2);
  assert.ok(s.m.history(20).some((h) => h.kind === 'goal_changed' && /스펙 버전 2/.test(h.detail)));
  assert.throws(() => s.m.answerDecision('db', 1, 'sqlite'), Rejected);
  assert.match(buildPrompt({ goal: 'v2', tasks: s.m.tasks(), runnable: [], capacity: 1, attempts: {}, decisions: [], history: [], outputs: {}, specVersion: 2 }), /"spec_version": 2/);
});

test('X5. 샌드박스 허용 경로를 주면 그곳에만 추가로 쓸 수 있다', { skip: !sandboxAvailable() }, async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'loop-ai-sbx-allow-'));
  const allowed = path.join(import.meta.dirname, '..', `.loopai-sbx-probe-allow-${process.pid}`);
  const other = path.join(import.meta.dirname, '..', `.loopai-sbx-probe-other-${process.pid}`);
  mkdirSync(allowed, { recursive: true });
  try {
    assert.equal((await runVerify({ command: `echo x > '${allowed}/f'`, trusted: false }, cwd)).passed, false, '허용하지 않으면 막힌다');
    assert.equal((await runVerify({ command: `echo x > '${allowed}/f'`, trusted: false, allow: [allowed] }, cwd)).passed, true);
    assert.equal((await runVerify({ command: `echo x > '${other}'`, trusted: false, allow: [allowed] }, cwd)).passed, false, '허용한 곳 밖은 여전히 막힌다');
    assert.equal(existsSync(other), false);
  } finally {
    rmSync(allowed, { recursive: true, force: true });
    rmSync(other, { force: true });
  }
});

test('X6. LLM 총괄로 돌릴 때 --accept 가 없으면 거절한다', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'loop-ai-rounds-cli-'));
  const cli = path.join(import.meta.dirname, '..', 'src', 'cli.ts');
  const run = (...a: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, ...a], { encoding: 'utf8' });
  assert.equal(run('init', dir, '--adapter', 'fake', '--coordinator', 'llm', '--coordinator-cli', 'claude').status, 0);
  const r = run('run', dir, '--verify', 'true', '--no-desktop');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /LLM 총괄을 쓸 때는 --accept 가 필요하다/);
});

test('X7. 인수 검증이 통과하면 총괄을 한 번 더 불러, 검증 결과를 본 총괄이 완료라고 하면 끝난다', async () => {
  const s = setup();
  s.m.setGoal('g');
  s.m.addTask('t', { prompt: 'p' });
  // 인수 검증 결과를 보기 전에는 끝나지 않았다고 하는 총괄
  const runner = async (prompt: string) => {
    const view = JSON.parse(prompt.slice(prompt.indexOf('{'))) as { runnable: string[]; tasks: { id: string; version: number }[]; last_acceptance: string | null };
    const passed = /인수 검증 통과/.test(view.last_acceptance ?? '');
    return {
      reasoning: 'r', goal_complete: passed,
      proposals: view.runnable.map((id) => ({ kind: 'dispatch', task_id: id, prompt: null, depends_on: null, blocked_by: null, expected_version: view.tasks.find((t) => t.id === id)!.version, decision_id: null, question: null, role: null, verify: null, files: null })),
    };
  };
  const r = await runLoop(s.m, base({ coordinator: llmCoordinator(runner), accept: { command: 'true', run: () => ({ passed: true, output: '' }) }, maxTicks: 15 }));
  assert.equal(r.status, 'done', '인수 검증 뒤 총괄이 완료라고 할 기회가 있어야 한다');
});
