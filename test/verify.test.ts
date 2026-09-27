import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Manager } from '../src/manager.ts';
import { FakeAdapter } from '../src/fake-adapter.ts';
import { runLoop, workspaceIntegrator, type LoopOptions } from '../src/loop.ts';
import { GitWorkspace } from '../src/workspace.ts';
import { runVerify, sandboxAvailable } from '../src/verify.ts';
import { buildPrompt, llmCoordinator } from '../src/llm-coordinator.ts';

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'loop-ai-verify-'));
  execFileSync('sh', ['-c', `git init -q -b main && git config user.email t@e.com && git config user.name t && printf '[ -f a.txt ] && [ -f b.txt ]\\n' > accept.sh && git add . && git commit -qm init`], { cwd: dir });
  const loopDir = path.join(dir, '.loop-ai');
  const ws = new GitWorkspace(dir, loopDir);
  ws.init();
  const adapter = FakeAdapter.init(path.join(loopDir, 'fake.json'));
  adapter.autoResult = 'succeeded';
  adapter.onLaunch = (req) => writeFileSync(path.join(req.workdir, `${req.prompt}.txt`), 'x\n');
  const notes: string[] = [];
  const m = new Manager(path.join(loopDir, 'state.db'), adapter, path.join(loopDir, 'work'), (r) => notes.push(r), {
    prepareWorkdir: (a) => ws.prepare(a),
  });
  const opts = (o: Partial<LoopOptions> = {}): LoopOptions => ({
    integrator: workspaceIntegrator(ws), maxConcurrent: 1, intervalMs: 1, maxTicks: 20,
    accept: { command: 'sh accept.sh', run: () => ws.accept({ command: 'sh accept.sh', trusted: true }) }, ...o,
  });
  return { dir, ws, adapter, m, notes, opts };
}

test('K1. 작업별 검증으로 각 작업이 따로 병합되고, 인수 검증은 모든 작업이 끝난 뒤 한 번 돈다', async () => {
  const s = setup();
  s.m.addTask('a', { prompt: 'a', verify: 'test -f a.txt' });
  s.m.addTask('b', { prompt: 'b', verify: 'test -f b.txt' });
  const r = await runLoop(s.m, s.opts());
  assert.equal(r.status, 'done');
  const h = s.m.history(80);
  assert.equal(h.filter((x) => x.kind === 'rework').length, 0, '먼저 끝난 작업이 인수 검증 때문에 되돌아가지 않는다');
  assert.equal(h.filter((x) => x.kind === 'acceptance_passed').length, 1);
  assert.ok(h.findIndex((x) => x.task_id === 'b' && x.kind === 'done') < h.findIndex((x) => x.kind === 'acceptance_passed'));
});

test('K2. 인수 검증이 실패하면 끝내지 않고 한 번 알린다. 고치는 작업이 끝나면 다시 돌려 통과한다', async () => {
  const s = setup();
  s.m.addTask('a', { prompt: 'a', verify: 'test -f a.txt' });
  const r = await runLoop(s.m, s.opts({ maxTicks: 8 }));
  assert.equal(r.status, 'max_ticks');
  const failed = s.m.history(80).filter((x) => x.kind === 'acceptance_failed');
  assert.equal(failed.length, 1, '같은 상태에서는 인수 검증을 되풀이하지 않는다');
  assert.equal(s.m.history(80).filter((x) => x.kind === 'alerted' && /인수 검증이 실패했다/.test(x.detail)).length, 1);
  s.m.addTask('b', { prompt: 'b', verify: 'test -f b.txt' });
  const r2 = await runLoop(s.m, s.opts());
  assert.equal(r2.status, 'done');
  assert.equal(s.m.attention().length, 0);
});

test('K3. 총괄이 제안한 검증 명령은 샌드박스에서 돌아 밖 쓰기가 막히고, 사용자 명령은 그대로 돈다', { skip: !sandboxAvailable() }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'loop-ai-sbx-'));
  const outside = path.join(import.meta.dirname, '..', `.loopai-sbx-probe-${process.pid}`);
  try {
    const inside = runVerify({ command: 'echo in > in.txt && git --version', trusted: false }, dir);
    assert.equal(inside.passed, true, inside.output);
    const blocked = runVerify({ command: `echo out > '${outside}'`, trusted: false }, dir);
    assert.equal(blocked.passed, false);
    assert.match(blocked.output, /Operation not permitted/);
    assert.equal(existsSync(outside), false);
    assert.equal(runVerify({ command: `echo out > '${outside}'`, trusted: true }, dir).passed, true);
    assert.equal(existsSync(outside), true);
  } finally {
    rmSync(outside, { force: true }); // 테스트가 만든 파일만 지운다
  }
});

test('K4. 총괄은 작업별 검증을 제안하고, 그 명령은 총괄 출처로 기록된다. 프롬프트에 인수 검증 명령이 들어간다', async () => {
  const s = setup();
  let seen = '';
  const coordinator = llmCoordinator(async (prompt) => {
    seen = prompt;
    return { reasoning: 'r', goal_complete: false, proposals: [
      { kind: 'add_task', task_id: 'a', prompt: 'a', depends_on: [], blocked_by: null, expected_version: null, decision_id: null, question: null, role: null, verify: 'test -f a.txt' },
    ] };
  });
  await runLoop(s.m, s.opts({ coordinator, maxTicks: 1 }));
  assert.match(seen, /"acceptance_command": "sh accept.sh"/);
  assert.equal(s.m.task('a').verify, 'test -f a.txt');
  assert.equal(s.m.task('a').verify_source, 'coordinator');
  assert.match(buildPrompt({ goal: 'g', tasks: [], runnable: [], capacity: 1, attempts: {}, decisions: [], history: [], outputs: {} }), /"verify" shell command that checks only that task/);
});

test('K5. CLI 는 --accept 만으로 돌고, --verify·--accept 가 모두 없으면 거절한다', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'loop-ai-verify-cli-'));
  const cli = path.join(import.meta.dirname, '..', 'src', 'cli.ts');
  const run = (...a: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, ...a], { encoding: 'utf8' });
  assert.equal(run('init', dir, '--adapter', 'fake').status, 0);
  assert.equal(run('add', dir, 'a', '--prompt', 'A', '--verify', 'true').status, 0);
  assert.equal(run('run', dir, '--interval', '10', '--no-desktop').status, 1);
  const r = run('run', dir, '--accept', 'true', '--interval', '10', '--no-desktop');
  assert.equal(r.status, 0, r.stderr);
  assert.match(run('status', dir).stdout, /acceptance_passed: 인수 검증 통과: true/);
});

