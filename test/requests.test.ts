import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Manager } from '../src/manager.ts';
import { FakeAdapter } from '../src/fake-adapter.ts';
import { tick } from '../src/loop.ts';

const cli = path.join(import.meta.dirname, '..', 'src', 'cli.ts');
const run = (...args: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, ...args], { encoding: 'utf8' });

test('Q1. 루프가 잠금을 쥐고 있으면 CLI 는 요청만 넣고, 루프가 다음 tick 에 반영한다', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'loop-ai-req-'));
  assert.equal(run('init', dir, '--adapter', 'fake').status, 0);
  // 실행 중인 루프 대신 잠금을 쥐고 있는 자식 프로세스
  const holder = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(import.meta.dirname, 'fixtures', 'hold-lock.ts'), path.join(dir, '.loop-ai', 'manager.lock')]);
  await new Promise<void>((r) => holder.stdout!.once('data', () => r()));
  try {
    const r = run('add', dir, 'a', '--prompt', 'A');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /루프가 실행 중이다. 요청 #1 를 넣었고/);
    const m = new Manager(path.join(dir, '.loop-ai', 'state.db'), new FakeAdapter(path.join(dir, '.loop-ai', 'adapter.json')), path.join(dir, 'w'), () => {});
    assert.equal(m.tasks().length, 0, '잠금 밖에서 상태를 고치지 않았다');
    await tick(m, { integrator: async () => ({ passed: true, sha: 's' }), maxConcurrent: 0, intervalMs: 1 });
    assert.deepEqual(m.tasks().map((t) => t.id), ['a']);
    assert.equal(m.request(1)?.status, 'applied');
    m.close();
  } finally {
    holder.kill('SIGKILL');
  }
});

test('Q2. 루프가 없으면 CLI 가 잠금을 잡고 바로 반영하고, 거절되면 이유와 함께 실패한다', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'loop-ai-req-'));
  assert.equal(run('init', dir, '--adapter', 'fake').status, 0);
  assert.match(run('add', dir, 'a', '--prompt', 'A').stdout, /작업 추가: a/);
  const dup = run('add', dir, 'a', '--prompt', 'again');
  assert.equal(dup.status, 1);
  assert.match(dup.stderr, /요청 거절/);
  const bad = run('answer', dir, 'nope', '1', 'x');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /요청 거절: 없는 결정: nope/);
  assert.match(run('status', dir).stdout, /request_rejected: 요청 #3 \(answer\) 거절/);
});
