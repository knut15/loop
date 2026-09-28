import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Manager } from '../src/manager.ts';
import { FakeAdapter } from '../src/fake-adapter.ts';
import { runLoop, tick, workspaceIntegrator } from '../src/loop.ts';
import { GitWorkspace, INTEGRATION_BRANCH } from '../src/workspace.ts';
import { buildPrompt } from '../src/llm-coordinator.ts';

// 실제 git 저장소에서 worktree 전달·통합·검증을 확인한다

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'loop-ai-git-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  writeFileSync(path.join(dir, 'app.txt'), 'line1\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  const loopDir = path.join(dir, '.loop-ai');
  const ws = new GitWorkspace(dir, loopDir);
  ws.init();
  const adapter = FakeAdapter.init(path.join(dir, '.loop-ai', 'fake.json'));
  adapter.autoResult = 'succeeded';
  const notes: string[] = [];
  const m = new Manager(path.join(loopDir, 'state.db'), adapter, path.join(loopDir, 'work'), (r) => notes.push(r), {
    prepareWorkdir: (a) => ws.prepare(a),
  });
  return { dir, git, ws, adapter, m, notes, loopDir };
}

test('W1. 작업마다 worktree 를 받아 고친 것이 통합 브랜치에 병합되고, 사용자 브랜치는 그대로다', async () => {
  const r = repo();
  // 작업자 흉내: 프롬프트에 적힌 파일을 만든다
  r.adapter.onLaunch = (req) => writeFileSync(path.join(req.workdir, `${req.prompt}.txt`), `${req.prompt}\n`);
  r.m.addTask('a', { prompt: 'a' });
  r.m.addTask('b', { prompt: 'b', dependsOn: ['a'] });
  const res = await runLoop(r.m, { integrator: workspaceIntegrator(r.ws, 'test -f a.txt'), maxConcurrent: 2, intervalMs: 1, maxTicks: 20 });
  assert.equal(res.status, 'done');
  const files = r.git('ls-tree', '--name-only', INTEGRATION_BRANCH).split('\n');
  assert.deepEqual(files.sort(), ['a.txt', 'app.txt', 'b.txt']);
  assert.equal(r.git('rev-parse', 'main'), r.git('rev-list', '--max-parents=0', 'main')); // main 은 init 커밋 그대로
  // b 의 worktree 는 a 가 병합된 뒤의 상태에서 시작했다
  const bAttempt = r.m.attempts('b')[0]!;
  assert.ok(existsSync(path.join(bAttempt.workdir, 'a.txt')));
  assert.match(r.m.history(50).find((h) => h.task_id === 'b' && h.kind === 'done')!.detail, /병합/);
});

test('W2. 통합 트리 검증이 실패하면 병합을 되돌리고 작업은 다시 실행 가능해진다', async () => {
  const r = repo();
  r.adapter.onLaunch = (req) => writeFileSync(path.join(req.workdir, 'bad.txt'), 'x\n');
  r.m.addTask('bad', { prompt: 'bad', maxAttempts: 1 });
  const before = r.git('rev-parse', INTEGRATION_BRANCH);
  await tick(r.m, { integrator: workspaceIntegrator(r.ws, 'test -f never.txt'), maxConcurrent: 1, intervalMs: 1 });
  await tick(r.m, { integrator: workspaceIntegrator(r.ws, 'test -f never.txt'), maxConcurrent: 1, intervalMs: 1 });
  assert.equal(r.git('rev-parse', INTEGRATION_BRANCH), before);
  assert.equal(r.git('status', '--porcelain', '--untracked-files=no').replace(/.*\.loop-ai.*\n?/g, ''), '');
  assert.ok(!existsSync(path.join(r.ws.integrationDir, 'bad.txt')));
  assert.equal(r.m.task('bad').state, 'ready');
  assert.match(r.m.history(50).find((h) => h.kind === 'rework')!.detail, /통합 트리 검증 실패/);
});

test('W3. 같은 줄을 고친 두 작업이 충돌하면 뒤의 것을 되돌리고, 새 기반에서 다시 돌려 병합한다', async () => {
  const r = repo();
  let round = 0;
  r.adapter.onLaunch = (req) => {
    round++;
    // 첫 두 시도는 같은 기반에서 같은 줄을 서로 다르게 고친다. 세 번째 시도는 최신 기반 위에서 고친다
    const f = path.join(req.workdir, 'app.txt');
    const cur = readFileSync(f, 'utf8');
    writeFileSync(f, round <= 2 ? `line1-${req.prompt}\n` : `${cur}${req.prompt}\n`);
  };
  r.m.addTask('x', { prompt: 'x' });
  r.m.addTask('y', { prompt: 'y' });
  const opts = { integrator: workspaceIntegrator(r.ws, 'true'), maxConcurrent: 2, intervalMs: 1, maxTicks: 20 };
  const res = await runLoop(r.m, opts);
  assert.equal(res.status, 'done');
  assert.ok(r.m.history(80).some((h) => h.kind === 'rework' && /병합 충돌/.test(h.detail)));
  assert.equal(r.m.attempts('x').length + r.m.attempts('y').length, 3);
  const content = r.git('show', `${INTEGRATION_BRANCH}:app.txt`);
  assert.match(content, /line1-(x|y)/);
});

test('W4. 재시작 뒤 같은 시도의 worktree 를 다시 만들려 해도 이미 있으면 그대로 쓴다', () => {
  const r = repo();
  r.m.addTask('t', { prompt: 't' });
  const a = { id: 'aaaaaaaa-0000', task_id: 't', request_id: 'req-x', workdir: path.join(r.loopDir, 'work', 'aaaaaaaa-0000'), prompt: 't', status: 'intent' as const, last_lookup: null };
  r.ws.prepare(a);
  writeFileSync(path.join(a.workdir, 'keep.txt'), 'k');
  r.ws.prepare(a);
  assert.ok(existsSync(path.join(a.workdir, 'keep.txt')));
});

test('W5. worktree 를 만들 수 없으면 그 시도를 실패로 기록한다', async () => {
  const r = repo();
  r.m.addTask('t', { prompt: 't', maxAttempts: 1 });
  r.git('branch', '-m', INTEGRATION_BRANCH, 'renamed'); // 통합 브랜치가 사라진 상황
  await tick(r.m, { integrator: workspaceIntegrator(r.ws, 'true'), maxConcurrent: 1, intervalMs: 1 });
  assert.equal(r.m.attempts('t')[0]!.status, 'failed');
  assert.ok(r.m.history(20).some((h) => h.kind === 'workspace_failed'));
  assert.equal(r.adapter.totalLaunches(), 0);
});

test('W6. 링크가 낀 경로(/tmp → /private/tmp)로 주어도 git 저장소 최상위로 알아본다', () => {
  const dir = mkdtempSync('/tmp/loop-ai-link-');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  assert.equal(GitWorkspace.isRepo(dir), true);
  assert.equal(GitWorkspace.isRepo(path.join(dir, '..')), false);
});

test('W7. 작업자가 보호된 인수 테스트를 바꾸면 병합하지 않고 한 번 알린다', async () => {
  const r = repo();
  const ws = new GitWorkspace(r.dir, r.loopDir, ['tests/**']);
  execFileSync('sh', ['-c', 'mkdir -p tests && echo "assert strict" > tests/accept.txt && git add . && git commit -qm tests'], { cwd: r.dir });
  execFileSync('git', ['merge', '-q', '--ff-only', 'main'], { cwd: ws.integrationDir }); // 인수 테스트를 통합 브랜치에 올린다
  r.adapter.onLaunch = (req) => {
    writeFileSync(path.join(req.workdir, 'tests', 'accept.txt'), 'assert loose\n'); // 테스트를 느슨하게 고친다
    writeFileSync(path.join(req.workdir, 'feature.txt'), 'f\n');
  };
  r.m.addTask('cheat', { prompt: 'cheat', maxAttempts: 2 });
  const before = r.git('rev-parse', INTEGRATION_BRANCH);
  const opts = { integrator: workspaceIntegrator(ws, 'true'), maxConcurrent: 1, intervalMs: 1, maxTicks: 8 };
  await runLoop(r.m, opts);
  assert.equal(r.git('rev-parse', INTEGRATION_BRANCH), before, '통합 브랜치가 그대로다');
  assert.equal(r.git('show', `${INTEGRATION_BRANCH}:tests/accept.txt`), 'assert strict');
  // 보고서에는 풀리지 않은 멈춤이 계속 실리므로, 알림 횟수는 alerted 기록으로 센다
  const alerts = r.m.history(80).filter((h) => h.kind === 'alerted' && /보호된 파일을 바꿔 병합하지 않았다: tests\/accept.txt/.test(h.detail));
  assert.equal(alerts.length, 1, '재시도해도 한 번만 알린다');
  assert.match(r.notes[0]!, /보호된 파일을 바꿔 병합하지 않았다/);
  assert.ok(r.m.history(50).some((h) => h.kind === 'rework' && /보호된 파일 변경/.test(h.detail)));
});

test('W8. 보호 패턴에 걸리지 않는 변경은 그대로 병합된다', async () => {
  const r = repo();
  const ws = new GitWorkspace(r.dir, r.loopDir, ['tests/**']);
  r.adapter.onLaunch = (req) => writeFileSync(path.join(req.workdir, 'feature.txt'), 'f\n');
  r.m.addTask('ok', { prompt: 'ok' });
  const res = await runLoop(r.m, { integrator: workspaceIntegrator(ws, 'test -f feature.txt'), maxConcurrent: 1, intervalMs: 1, maxTicks: 8 });
  assert.equal(res.status, 'done');
});

test('W9. 병합 충돌로 날린 시도는 돌려주고, 충돌한 작업은 다른 작업이 없을 때 다시 돌려 끝까지 간다', async () => {
  const r = repo();
  r.adapter.onLaunch = (req) => {
    const f = path.join(req.workdir, 'app.txt');
    writeFileSync(f, `${readFileSync(f, 'utf8')}${req.prompt}\n`); // 같은 파일 끝에 한 줄씩 덧붙인다 → 동시에 돌면 충돌
  };
  for (const id of ['x', 'y', 'z']) r.m.addTask(id, { prompt: id, maxAttempts: 1 });
  const res = await runLoop(r.m, { integrator: workspaceIntegrator(r.ws, 'true'), maxConcurrent: 3, intervalMs: 1, maxTicks: 40 });
  assert.equal(res.status, 'done');
  const h = r.m.history(200);
  assert.ok(h.some((x) => x.kind === 'conflict_refund'), '충돌이 실제로 났고 시도를 돌려줬다');
  const content = r.git('show', `${INTEGRATION_BRANCH}:app.txt`).split('\n');
  assert.deepEqual(content.filter((l) => ['x', 'y', 'z'].includes(l)).sort(), ['x', 'y', 'z']);
});

test('W10. 작업자 디렉터리에 생긴 도구 상태 파일(.omc/)은 커밋하지 않고, 작업 결과만 병합한다', async () => {
  const r = repo();
  r.adapter.onLaunch = (req) => {
    writeFileSync(path.join(req.workdir, 'out.txt'), 'ok\n');
    execFileSync('sh', ['-c', 'mkdir -p .omc/state && echo x > .omc/state/s.json'], { cwd: req.workdir });
  };
  r.m.addTask('t', { prompt: 't' });
  const res = await runLoop(r.m, { integrator: workspaceIntegrator(r.ws, 'test -f out.txt'), maxConcurrent: 1, intervalMs: 1, maxTicks: 10 });
  assert.equal(res.status, 'done');
  assert.deepEqual(r.git('ls-tree', '-r', '--name-only', INTEGRATION_BRANCH).split('\n').sort(), ['app.txt', 'out.txt']);
});

test('W11. 총괄에게 통합 브랜치의 파일 목록과, goal 이 가리키는 파일의 내용을 보여 준다', () => {
  const r = repo();
  execFileSync('sh', ['-c', 'mkdir -p docs && printf "# 스펙\\nbook(slotId, user)\\n" > docs/SPEC.md && echo other > other.md && git add . && git commit -qm spec'], { cwd: r.ws.integrationDir });
  const v = r.ws.projectView('SPEC.md 대로 구현한다');
  assert.deepEqual(v.files.sort(), ['app.txt', 'docs/SPEC.md', 'other.md']);
  assert.deepEqual(Object.keys(v.docs), ['docs/SPEC.md'], 'goal 이 이름을 댄 파일만 내용을 넣는다');
  assert.match(v.docs['docs/SPEC.md']!, /book\(slotId, user\)/);
  const prompt = buildPrompt({ goal: 'SPEC.md 대로 구현한다', tasks: [], runnable: [], capacity: 1, attempts: {}, decisions: [], history: [], outputs: {}, project: v });
  assert.match(prompt, /"project_docs"/);
  assert.match(prompt, /book\(slotId, user\)/);
  assert.match(prompt, /instead of asking the user/);
});
