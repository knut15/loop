import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Manager } from '../src/manager.ts';
import { FakeAdapter } from '../src/fake-adapter.ts';
import { runLoop, tick, workspaceIntegrator, type LoopOptions } from '../src/loop.ts';
import { GitWorkspace } from '../src/workspace.ts';
import { buildReviewPrompt, llmReviewer, REVIEW_SCHEMA, type ReviewInput, type Reviewer } from '../src/reviewer.ts';
import { llmCoordinator } from '../src/llm-coordinator.ts';

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'loop-ai-review-'));
  execFileSync('sh', ['-c', 'git init -q -b main && git config user.email t@e.com && git config user.name t && echo base > app.txt && git add . && git commit -qm init'], { cwd: dir });
  const loopDir = path.join(dir, '.loop-ai');
  const ws = new GitWorkspace(dir, loopDir);
  ws.init();
  const adapter = FakeAdapter.init(path.join(loopDir, 'fake.json'));
  adapter.autoResult = 'succeeded';
  adapter.onLaunch = (req) => writeFileSync(path.join(req.workdir, 'feature.txt'), `${req.prompt.length}\n`);
  const notes: string[] = [];
  const m = new Manager(path.join(loopDir, 'state.db'), adapter, path.join(loopDir, 'work'), (r) => notes.push(r), {
    prepareWorkdir: (a) => ws.prepare(a),
  });
  const opts = (reviewer: Reviewer, extra: Partial<LoopOptions> = {}): LoopOptions => ({
    integrator: workspaceIntegrator(ws, 'true'), maxConcurrent: 1, intervalMs: 1, maxTicks: 20,
    reviewer, changes: (a) => ws.changes(a), ...extra,
  });
  return { dir, ws, adapter, m, notes, opts };
}

test('V1. 검토자가 승인하면 통합되고, 검토자는 실제 diff 를 받는다', async () => {
  const s = setup();
  const seen: ReviewInput[] = [];
  const r = await runLoop(s.m, s.opts(async (i) => { seen.push(i); return { approve: true, issues: [], summary: 'ok' }; }));
  assert.equal(r.status, 'max_ticks'); // 작업이 없으니 끝나지 않는다 (아래에서 작업을 넣고 다시 확인)
  s.m.addTask('t', { prompt: 'make feature' });
  const r2 = await runLoop(s.m, s.opts(async (i) => { seen.push(i); return { approve: true, issues: [], summary: 'ok' }; }));
  assert.equal(r2.status, 'done');
  assert.equal(seen.length, 1);
  assert.match(seen[0]!.changes, /\+\+\+ b\/feature\.txt/);
  assert.ok(s.m.history(50).some((h) => h.kind === 'review_approved'));
});

test('V2. 검토자가 반려하면 통합하지 않고, 의견을 붙여 다시 돌린 뒤 승인되면 통합한다', async () => {
  const s = setup();
  s.m.addTask('t', { prompt: 'make feature' });
  let calls = 0;
  const reviewer: Reviewer = async () => (++calls === 1
    ? { approve: false, issues: ['feature.txt must end with a newline', 'add a test'], summary: 'incomplete' }
    : { approve: true, issues: [], summary: 'ok' });
  const r = await runLoop(s.m, s.opts(reviewer));
  assert.equal(r.status, 'done');
  const [first, second] = s.m.attempts('t');
  assert.doesNotMatch(first!.prompt, /Reviewer feedback/);
  assert.match(second!.prompt, /Reviewer feedback on the previous attempt[\s\S]*add a test/);
  assert.ok(s.m.history(50).some((h) => h.kind === 'rework' && /검토 반려: incomplete/.test(h.detail)));
});

test('V3. 검토자 호출이 3번 연속 실패하면 한 번 알리고, 그동안 통합하지 않는다', async () => {
  const s = setup();
  s.m.addTask('t', { prompt: 'p' });
  const o = s.opts(async () => { throw new Error('reviewer down'); });
  for (let i = 0; i < 5; i++) await tick(s.m, o);
  assert.equal(s.m.task('t').state, 'integrating');
  const alerted = s.m.history(80).filter((h) => h.kind === 'alerted' && /검토자 호출이 3번 연속 실패/.test(h.detail));
  assert.equal(alerted.length, 1);
  await tick(s.m, s.opts(async () => ({ approve: true, issues: [], summary: 'ok' })));
  assert.equal(s.m.task('t').state, 'done');
  assert.equal(s.m.attention().length, 0);
});

test('V4. 역할 지침이 작업 프롬프트 앞에 붙고, 총괄은 없는 역할을 쓸 수 없다', async () => {
  const s = setup();
  const roles = { qa: '---\ndescription: 테스트를 먼저 쓰는 QA 담당\n---\nYou are QA. Write tests first.' };
  s.m.addTask('t', { prompt: 'make feature', role: 'qa' });
  await tick(s.m, s.opts(async () => ({ approve: true, issues: [], summary: 'ok' }), { roles }));
  assert.match(s.m.attempts('t')[0]!.prompt, /^---\ndescription[\s\S]*You are QA\.[\s\S]*---\nmake feature$/);

  const coordinator = llmCoordinator(async (prompt) => {
    assert.match(prompt, /"name": "qa"[\s\S]*"summary": "테스트를 먼저 쓰는 QA 담당"/);
    return { reasoning: 'r', goal_complete: false, proposals: [
      { kind: 'add_task', task_id: 'u', prompt: 'x', depends_on: [], blocked_by: null, expected_version: null, decision_id: null, question: null, role: 'qa' },
      { kind: 'add_task', task_id: 'v', prompt: 'x', depends_on: [], blocked_by: null, expected_version: null, decision_id: null, question: null, role: 'devops' },
    ] };
  });
  s.m.addTask('trigger', { prompt: 'x' }); // 상태를 바꿔 총괄을 부르게 한다
  await tick(s.m, s.opts(async () => ({ approve: true, issues: [], summary: 'ok' }), { roles, coordinator, maxConcurrent: 5 }));
  assert.equal(s.m.task('u').role, 'qa');
  assert.ok(!s.m.tasks().some((t) => t.id === 'v'));
  assert.ok(s.m.history(80).some((h) => h.kind === 'proposal_rejected' && /없는 역할: devops/.test(h.detail)));
});

test('V5. 검토 프롬프트에 과제·변경·작업자 응답이 들어가고, 스키마 위반은 실패로 센다', async () => {
  const p = buildReviewPrompt({ goal: 'G', taskId: 't', prompt: 'P', changes: 'DIFF', output: 'OUT' });
  for (const w of ['You did not write this change', 'G', 'P', 'DIFF', 'OUT', 'weaken']) assert.ok(p.includes(w), w);
  await assert.rejects(llmReviewer(async (_p, schema) => { assert.equal(schema, REVIEW_SCHEMA); return { nope: 1 }; })({ goal: '', taskId: 't', prompt: '', changes: '' }));
});
