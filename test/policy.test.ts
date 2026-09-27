import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Manager } from '../src/manager.ts';
import { FakeAdapter } from '../src/fake-adapter.ts';
import { tick, type Integrator } from '../src/loop.ts';
import { buildPrompt } from '../src/llm-coordinator.ts';
import { capability, claudeArgs, codexArgs } from '../src/policy.ts';

test('P1. 정책 수준마다 CLI 가 직접 강제하는 옵션으로 옮긴다', () => {
  const ws = claudeArgs('workspace-write');
  assert.ok(ws.includes('--restricted'));
  assert.deepEqual(ws.slice(ws.indexOf('--permission-mode'), ws.indexOf('--permission-mode') + 2), ['--permission-mode', 'dontAsk']);
  // Bash 는 샌드박스 설정과 함께일 때만 허용한다
  assert.ok(ws.includes('Bash'));
  const settings = JSON.parse(ws[ws.indexOf('--settings') + 1]!);
  assert.deepEqual(settings.sandbox, { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false });
  assert.equal(ws.at(-1), '--'); // 프롬프트가 --allowedTools 값으로 먹히지 않게 한다
  assert.ok(!claudeArgs('read-only').includes('Write'));
  assert.deepEqual(codexArgs('workspace-write'), ['--ignore-user-config', '-s', 'workspace-write']);
  assert.deepEqual(codexArgs('read-only'), ['--ignore-user-config', '-s', 'read-only']);
  // 사용자 환경의 MCP 서버를 작업자에게 붙이지 않는다
  assert.ok(ws.includes('--strict-mcp-config'));
  assert.ok(claudeArgs('read-only').includes('--strict-mcp-config'));
  assert.ok(claudeArgs('full').includes('bypassPermissions'));
  assert.ok(codexArgs('full')[0]!.includes('bypass'));
});

test('P2. 작업자가 권한 밖 요청을 거절당하면 한 번 알리고, 그 작업이 done 이 되면 내린다', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'loop-ai-policy-'));
  const adapter = FakeAdapter.init(path.join(dir, 'fake.json'));
  adapter.autoResult = 'succeeded';
  const notes: string[] = [];
  const m = new Manager(path.join(dir, 'state.db'), adapter, path.join(dir, 'work'), (r) => notes.push(r));
  m.addTask('t', { prompt: 'T' });
  let pass = false;
  const integrator: Integrator = async () => ({ passed: pass, sha: 'sha' });
  const opts = { integrator, maxConcurrent: 1, intervalMs: 1, readDenials: () => ['Write({"file_path":"/outside.txt"})'] };

  await tick(m, opts); // dispatch
  await tick(m, opts); // 끝난 시도 확인 → 거절 발견, 검증 실패로 다시 ready
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /권한 밖 요청 1건을 거절당했다: Write/);
  assert.ok(m.history(50).some((h) => h.kind === 'permission_denied'));
  await tick(m, opts);
  assert.equal(notes.length, 1, '같은 거절을 다시 알리지 않는다');

  pass = true;
  for (let i = 0; i < 4; i++) await tick(m, { ...opts, readDenials: () => [] });
  assert.equal(m.task('t').state, 'done');
  assert.equal(m.attention().length, 0);
});

test('P3. 총괄 프롬프트에 작업자가 할 수 있는 일을 적는다', () => {
  const base = { goal: 'g', tasks: [], runnable: [], capacity: 1, attempts: {}, decisions: [], history: [], outputs: {} };
  assert.match(buildPrompt({ ...base, capability: capability('claude', 'workspace-write') }), /run shell commands .* in a sandbox/);
  assert.match(buildPrompt({ ...base, capability: capability('codex', 'workspace-write') }), /network is blocked/);
  assert.match(buildPrompt(base), /can only reply with text/);
});

test('P4. init 기본 정책은 workspace-write 이고, policy 명령으로 바꾸면 히스토리에 남는다', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'loop-ai-policy-cli-'));
  const cli = path.join(import.meta.dirname, '..', 'src', 'cli.ts');
  const run = (...args: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, ...args], { encoding: 'utf8' });
  assert.equal(run('init', dir, '--adapter', 'fake').status, 0);
  const cfg = () => JSON.parse(readFileSync(path.join(dir, '.loop-ai', 'config.json'), 'utf8'));
  assert.equal(cfg().workerAccess, 'workspace-write');
  assert.match(run('policy', dir).stdout, /작업자 권한: workspace-write/);
  const r = run('policy', dir, 'read-only');
  assert.equal(r.status, 0);
  assert.equal(cfg().workerAccess, 'read-only');
  assert.match(run('status', dir).stdout, /policy_changed: 작업자 권한 workspace-write → read-only/);
  assert.equal(run('policy', dir, 'root').status, 1);
  assert.match(run('policy', dir, 'full').stderr, /경고/);
});
