import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Manager } from '../src/manager.ts';
import { FakeAdapter } from '../src/fake-adapter.ts';
import { runLoop, tick, type Integrator, type LoopOptions } from '../src/loop.ts';
import { buildPrompt, llmCoordinator, PLAN_SCHEMA } from '../src/llm-coordinator.ts';
import type { LlmRunner } from '../src/llm.ts';

// 대본대로 응답하는 가짜 LLM 으로 총괄을 검증한다

type P = Record<string, unknown>;
const add = (id: string, prompt: string, deps: string[] = [], blockedBy: string | null = null): P =>
  ({ kind: 'add_task', task_id: id, prompt, depends_on: deps, blocked_by: blockedBy, expected_version: null, decision_id: null, question: null });
const dispatch = (id: string, v: number): P =>
  ({ kind: 'dispatch', task_id: id, prompt: null, depends_on: null, blocked_by: null, expected_version: v, decision_id: null, question: null });
const ask = (id: string, q: string): P =>
  ({ kind: 'ask_user', task_id: null, prompt: null, depends_on: null, blocked_by: null, expected_version: null, decision_id: id, question: q });
const plan = (proposals: P[], goal_complete = false) => ({ reasoning: 'test', goal_complete, proposals });

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'loop-ai-coord-'));
  const adapter = FakeAdapter.init(path.join(dir, 'fake.json'));
  adapter.autoResult = 'succeeded';
  const notes: string[] = [];
  const m = new Manager(path.join(dir, 'state.db'), adapter, path.join(dir, 'work'), (r) => notes.push(r));
  m.setGoal('인사말 두 개를 만든다');
  return { dir, adapter, m, notes };
}

// 스냅샷을 보고 응답을 고르는 가짜 러너. 부른 횟수와 받은 프롬프트를 남긴다
function scripted(fn: (prompt: string, call: number) => unknown) {
  const calls: string[] = [];
  const runner: LlmRunner = async (prompt, schema) => {
    assert.equal(schema, PLAN_SCHEMA);
    calls.push(prompt);
    return fn(prompt, calls.length);
  };
  return { runner, calls };
}

const pass: Integrator = async () => ({ passed: true, sha: 'sha' });
const opts = (o: Partial<LoopOptions>): LoopOptions => ({ integrator: pass, maxConcurrent: 2, intervalMs: 1, maxTicks: 30, ...o });

// 상태를 읽어 다음 행동을 정하는, 규칙대로 움직이는 총괄 대본
function sensible(prompt: string): unknown {
  const state = JSON.parse(prompt.slice(prompt.indexOf('{'))) as {
    tasks: { id: string; state: string; version: number }[]; runnable: string[]; capacity: number;
  };
  if (state.tasks.length === 0) return plan([add('hello', 'Say HELLO'), add('world', 'Say WORLD', ['hello'])]);
  if (state.tasks.every((t) => t.state === 'done')) return plan([], true);
  return plan(state.runnable.slice(0, state.capacity).map((id) => dispatch(id, state.tasks.find((t) => t.id === id)!.version)));
}

test('C1. goal 을 작업으로 나누고, 의존 순서대로 돌린 뒤 총괄이 완료라고 해야 끝난다', async () => {
  const s = setup();
  const { runner, calls } = scripted(sensible);
  const r = await runLoop(s.m, opts({ coordinator: llmCoordinator(runner) }));
  assert.equal(r.status, 'done');
  assert.deepEqual(s.m.tasks().map((t) => [t.id, t.state]), [['hello', 'done'], ['world', 'done']]);
  assert.equal(s.m.task('world').depends_on, 'hello');
  const h = s.m.history().map((x) => `${x.task_id}:${x.kind}`);
  assert.ok(h.indexOf('hello:done') < h.indexOf('world:intent'));
  assert.match(calls[0]!, /인사말 두 개를 만든다/);
  assert.ok(calls.length <= 8, `총괄 호출 ${calls.length}회`);
  assert.equal(s.m.history(100).filter((h) => h.kind === 'coordinator_called').length, calls.length);
});

test('C2. 모든 작업이 done 이어도 총괄이 완료라고 하지 않으면 끝내지 않고, 다음 작업이 없으면 알린다', async () => {
  const s = setup();
  const { runner } = scripted((p, n) => (n === 1 ? plan([add('a', 'A')]) : sensibleNoComplete(p)));
  const r = await runLoop(s.m, opts({ coordinator: llmCoordinator(runner), maxTicks: 8 }));
  assert.equal(r.status, 'max_ticks');
  assert.equal(s.m.task('a').state, 'done');
  assert.equal(s.notes.length, 1);
  assert.match(s.notes[0]!, /다음 작업을 내지 않았다/);
});

function sensibleNoComplete(prompt: string): unknown {
  const r = sensible(prompt) as { goal_complete: boolean };
  return { ...r, goal_complete: false };
}

test('C3. 잘못된 제안은 이유와 함께 거절하고 올바른 것만 적용한다', async () => {
  const s = setup();
  s.m.addTask('keep', { prompt: 'K' });
  const { runner } = scripted(() => plan([
    add('Bad ID', 'x'),
    add('keep', 'dup'),
    add('orphan', 'x', ['nope']),
    add('empty', ''),
    add('ok', 'fine', ['keep']),
    dispatch('keep', 99),
    dispatch('ok', 0),
    ask('q1', '어떤 DB 를 쓸까요?'),
    ask('q2', '두 번째 질문'),
    { kind: 'launch_missiles', task_id: 'x', prompt: null, depends_on: null, blocked_by: null, expected_version: null, decision_id: null, question: null },
  ]));
  await tick(s.m, opts({ coordinator: llmCoordinator(runner) }));
  assert.deepEqual(s.m.tasks().map((t) => t.id), ['keep', 'ok']);
  assert.equal(s.adapter.totalLaunches(), 0); // keep 은 버전이 틀렸고, ok 는 선행 작업이 안 끝났다
  assert.equal(s.m.hasDecision('q1'), true);
  assert.equal(s.m.hasDecision('q2'), false);
  const rejected = s.m.history(50).filter((h) => h.kind === 'proposal_rejected').map((h) => h.detail);
  for (const re of [/형식이 아니다/, /이미 있는 작업/, /없는 선행 작업/, /프롬프트가 비었다/, /상태 버전이 다르다/, /선행 작업이 끝나지 않았다/, /한 번에 하나만/, /모르는 제안 종류/]) {
    assert.ok(rejected.some((d) => re.test(d)), `거절 사유 없음: ${re}`);
  }
});

test('C4. 총괄 호출이 3번 연속 실패하면 한 번 알리고, 다시 성공하면 멈춤이 풀린다', async () => {
  const s = setup();
  let fail = true;
  const { runner } = scripted((p) => {
    if (fail) throw new Error('rate limited');
    return sensible(p);
  });
  const c = llmCoordinator(runner);
  for (let i = 0; i < 4; i++) await tick(s.m, opts({ coordinator: c }));
  assert.equal(s.notes.length, 1);
  assert.match(s.notes[0]!, /총괄 호출이 3번 연속 실패했다: rate limited/);
  assert.equal(s.m.attention().length, 1);
  fail = false;
  await tick(s.m, opts({ coordinator: c }));
  assert.equal(s.m.attention().length, 0);
  assert.equal(s.m.tasks().length, 2);
});

test('C5. 상태가 바뀌지 않으면 총괄을 다시 부르지 않는다', async () => {
  const s = setup();
  s.adapter.autoResult = undefined; // 작업자가 끝나지 않는다
  const { runner, calls } = scripted(sensible);
  const c = llmCoordinator(runner);
  for (let i = 0; i < 6; i++) await tick(s.m, opts({ coordinator: c, maxConcurrent: 1 }));
  // 첫 호출: 계획. 두 번째: hello dispatch. 그 뒤로는 hello 가 도는 중이라 바뀐 것이 없다
  assert.equal(calls.length, 2);
  assert.equal(s.adapter.totalLaunches(), 1);
});

test('C6. 사용자 질문을 알리고, 응답이 들어오면 막혀 있던 작업이 이어진다', async () => {
  const s = setup();
  const { runner, calls } = scripted((prompt, n) => {
    if (n === 1) return plan([ask('db', 'PostgreSQL 과 SQLite 중 무엇을 쓸까요?'), add('schema', 'Write schema', [], 'db')]);
    return sensible(prompt);
  });
  const c = llmCoordinator(runner);
  await tick(s.m, opts({ coordinator: c }));
  assert.equal(s.m.task('schema').state, 'blocked');
  assert.equal(s.notes.length, 1);
  assert.match(s.notes[0]!, /PostgreSQL 과 SQLite 중 무엇을 쓸까요\?/);
  s.m.answerDecision('db', 1, 'SQLite');
  const r = await runLoop(s.m, opts({ coordinator: c }));
  assert.equal(r.status, 'done');
  assert.ok(calls.some((p) => p.includes('"answer": "SQLite"')));
});

test('C7. 스냅샷에 끝난 작업의 결과가 들어가 다음 프롬프트에 옮길 수 있다', () => {
  const s = setup();
  s.m.addTask('a', { prompt: 'A' });
  const prompt = buildPrompt({
    goal: 'g', tasks: s.m.tasks(), runnable: ['a'], capacity: 1, attempts: {}, decisions: [], history: [],
    outputs: { a: 'RESULT-OF-A' },
  });
  assert.match(prompt, /"result": "RESULT-OF-A"/);
});

test('C8. 스키마에 맞지 않는 응답은 실패로 센다', async () => {
  const s = setup();
  const { runner } = scripted(() => ({ nope: true }));
  await tick(s.m, opts({ coordinator: llmCoordinator(runner) }));
  assert.equal(s.m.tasks().length, 0);
  assert.ok(s.m.history().some((h) => h.kind === 'coordinator_failed' && /스키마/.test(h.detail)));
});

test('C9. dispatch 때 총괄이 준 프롬프트로 실행해 선행 작업의 결과를 넘길 수 있다', async () => {
  const s = setup();
  s.adapter.autoResult = undefined;
  s.m.addTask('b', { prompt: 'Translate [PLACEHOLDER]' });
  const { runner } = scripted(() => plan([{ ...dispatch('b', 0), prompt: 'Translate "Hello there"' }]));
  await tick(s.m, opts({ coordinator: llmCoordinator(runner) }));
  assert.equal(s.m.attempts('b')[0]!.prompt, 'Translate "Hello there"');
});

test('S1. 작업자가 살아 있어도 정해진 시간을 넘기면 한 번 알린다. 죽이거나 재시도하지 않는다', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'loop-ai-slow-'));
  const adapter = FakeAdapter.init(path.join(dir, 'fake.json'));
  let clock = 1_000_000;
  const notes: string[] = [];
  const m = new Manager(path.join(dir, 'state.db'), adapter, path.join(dir, 'work'), (r) => notes.push(r), {
    stallAfterMs: 10 * 60_000, now: () => clock,
  });
  m.addTask('t', { prompt: 'T' });
  await tick(m, opts({}));
  await m.recover();
  assert.equal(notes.length, 0);
  clock += 11 * 60_000;
  await m.recover();
  await m.recover();
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /작업자가 11분째 끝나지 않는다/);
  assert.equal(adapter.totalLaunches(), 1);
  assert.equal(m.attempts('t')[0]!.status, 'launched');
});
