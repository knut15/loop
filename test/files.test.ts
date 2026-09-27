import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Manager } from '../src/manager.ts';
import { FakeAdapter } from '../src/fake-adapter.ts';
import { runLoop, tick, type LoopOptions } from '../src/loop.ts';
import { buildPrompt, llmCoordinator } from '../src/llm-coordinator.ts';
import type { LlmRunner } from '../src/llm.ts';

// 작업이 고칠 파일이 겹치면 동시에 돌리지 않는다.
// 같은 파일을 고치는 작업 4개를 동시에 돌렸더니 병합 충돌과 재시도가 늘어 한 줄로 돌릴 때보다 느렸다 (N=1 51초, N=4 61초)

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'loop-ai-files-'));
  const adapter = FakeAdapter.init(path.join(dir, 'fake.json'));
  adapter.autoResult = 'succeeded';
  const m = new Manager(path.join(dir, 'state.db'), adapter, path.join(dir, 'work'), () => {});
  return { dir, adapter, m };
}
const base = (o: Partial<LoopOptions>): LoopOptions => ({ integrator: async () => ({ passed: true, sha: 's' }), maxConcurrent: 3, intervalMs: 1, maxTicks: 30, ...o });

test('F1. 돌고 있는 작업과 고칠 파일이 겹치는 작업은 실행 가능 목록에서 빠지고, 직접 dispatch 해도 거절한다', async () => {
  const s = setup();
  s.m.addTask('a', { prompt: 'p', files: ['src/a.js'] });
  s.m.addTask('b', { prompt: 'p', files: ['src/*.js'] });
  s.m.addTask('c', { prompt: 'p', files: ['docs/x.md'] });
  s.m.addTask('d', { prompt: 'p' });
  await s.m.dispatch('a', 0, 'p');
  assert.deepEqual(s.m.runnable(), ['c', 'd'], 'glob 으로 겹치는 b 만 빠진다. 파일을 적지 않은 d 는 제한하지 않는다');
  await assert.rejects(s.m.dispatch('b', 0, 'p'), /돌고 있는 작업 a 와 겹친다/);
});

test('F2. 겹치는 작업은 앞 작업이 끝난 뒤에 돌고, 겹치지 않는 작업은 함께 돌아 모두 끝난다', async () => {
  const s = setup();
  s.m.addTask('a', { prompt: 'p', files: ['shared.txt'] });
  s.m.addTask('b', { prompt: 'p', files: ['shared.txt'] });
  s.m.addTask('c', { prompt: 'p', files: ['other.txt'] });
  const r = await runLoop(s.m, base({}));
  assert.equal(r.status, 'done');
  const h = s.m.history(100);
  const at = (task: string, kind: string) => h.findIndex((x) => x.task_id === task && x.kind === kind);
  assert.ok(at('b', 'intent') > at('a', 'done'), 'b 는 a 가 병합된 뒤에 시작한다');
  assert.ok(at('c', 'intent') < at('a', 'done'), 'c 는 a 와 함께 돈다');
});

test('F3. 총괄이 작업마다 고칠 파일을 적으면 저장되고, 총괄 프롬프트에 파일과 겹치지 않게 나누라는 규칙이 들어간다', async () => {
  const s = setup();
  const add = (id: string, files: string[] | null) => ({ kind: 'add_task', task_id: id, prompt: 'build', depends_on: [], blocked_by: null, expected_version: null, decision_id: null, question: null, role: null, verify: null, files });
  const runner: LlmRunner = async () => ({ reasoning: 't', goal_complete: false, proposals: [add('api', ['src/api.js', 'test/api.test.js']), add('bad', ['a,b'])] });
  await tick(s.m, base({ coordinator: llmCoordinator(runner) }));
  assert.equal(s.m.task('api').files, 'src/api.js,test/api.test.js');
  assert.ok(!s.m.tasks().some((t) => t.id === 'bad'), '쉼표가 든 경로는 거절한다');
  assert.ok(s.m.history(20).some((h) => h.kind === 'proposal_rejected' && /쉼표/.test(h.detail)));
  const prompt = buildPrompt({ goal: 'g', tasks: s.m.tasks(), runnable: [], capacity: 1, attempts: {}, decisions: [], history: [], outputs: {} });
  assert.match(prompt, /"src\/api\.js"/);
  assert.match(prompt, /files do not overlap/);
});

test('F4. 작업 상한은 끝나지 않은 작업만 센다. 끝난 작업이 50개여도 새 작업을 더할 수 있다', async () => {
  const s = setup();
  for (let i = 0; i < 50; i++) { s.m.addTask(`old-${i}`, { prompt: 'p' }); s.m.cancelTask(`old-${i}`, 'test'); }
  const add = (id: string) => ({ kind: 'add_task', task_id: id, prompt: 'build', depends_on: [], blocked_by: null, expected_version: null, decision_id: null, question: null, role: null, verify: null, files: null });
  let calls = 0;
  const runner: LlmRunner = async () => (calls++ === 0
    ? { reasoning: 't', goal_complete: false, proposals: [add('new-0')] }
    : { reasoning: 't', goal_complete: false, proposals: Array.from({ length: 10 }, (_, i) => add(`more-${calls}-${i}`)) });
  const coord = llmCoordinator(runner);
  await tick(s.m, base({ coordinator: coord, maxConcurrent: 1 }));
  assert.ok(s.m.tasks().some((t) => t.id === 'new-0'));
  // 끝나지 않은 작업이 50개에 닿으면 더 받지 않는다
  for (let i = 1; i < 50; i++) s.m.addTask(`open-${i}`, { prompt: 'p' });
  await tick(s.m, base({ coordinator: coord, maxConcurrent: 1 }));
  assert.ok(s.m.history(40).some((h) => h.kind === 'proposal_rejected' && /끝나지 않은 작업은 50개까지다/.test(h.detail)));
});

test('F5. 총괄 프롬프트에서 끝난 작업은 짧게, 뒤 작업이 기대는 끝난 작업의 결과는 그대로, 오래된 것은 개수만 남긴다', () => {
  const s = setup();
  for (let i = 0; i < 55; i++) { s.m.addTask(`old-${i}`, { prompt: 'long prompt '.repeat(50) }); s.m.cancelTask(`old-${i}`, 'test'); }
  s.m.addTask('dep', { prompt: 'p' });
  s.m.cancelTask('dep', 'test');
  s.m.addTask('next', { prompt: 'uses dep', dependsOn: ['dep'] });
  const long = 'R'.repeat(900);
  const outputs: Record<string, string> = { dep: long, 'old-54': long };
  const prompt = buildPrompt({ goal: 'g', tasks: s.m.tasks(), runnable: [], capacity: 1, attempts: {}, decisions: [], history: [], outputs });
  const view = JSON.parse(prompt.slice(prompt.indexOf('{'))) as { tasks: { id: string }[]; finished_tasks: { id: string; result?: string; prompt?: string }[]; finished_tasks_omitted: number };
  assert.deepEqual(view.tasks.map((t) => t.id), ['next']);
  assert.equal(view.finished_tasks.length, 50);
  assert.equal(view.finished_tasks_omitted, 6);
  assert.equal(view.finished_tasks.find((t) => t.id === 'dep')!.result, long, '뒤 작업이 기대는 결과는 자르지 않는다');
  assert.equal(view.finished_tasks.find((t) => t.id === 'old-54')!.result!.length, 200);
  assert.equal(view.finished_tasks[0]!.prompt, undefined, '끝난 작업의 프롬프트는 넣지 않는다');
});
