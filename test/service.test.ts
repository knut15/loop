import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { plistPath, renderPlist, serviceLabel } from '../src/service.ts';

test('S1. launchd 설정은 비정상 종료 때만 다시 띄우고, 프로젝트마다 이름이 고정된다', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'loop-ai-svc-'));
  const xml = renderPlist({ projectDir: dir, runArgs: ['--accept', 'node --test && echo "<ok>"'], node: '/usr/bin/node', cli: '/x/cli.js', pathEnv: '/usr/bin' });
  assert.equal(serviceLabel(dir), serviceLabel(dir + '/'));
  assert.notEqual(serviceLabel(dir), serviceLabel(dir + '-other'));
  assert.match(plistPath(dir), /Library\/LaunchAgents\/dev\.loop-ai\.[0-9a-f]{10}\.plist$/);
  const f = path.join(dir, 'x.plist');
  writeFileSync(f, xml);
  if (process.platform === 'darwin') {
    execFileSync('plutil', ['-lint', f]);
    const d = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', f], { encoding: 'utf8' }));
    assert.deepEqual(d.KeepAlive, { SuccessfulExit: false });
    assert.equal(d.RunAtLoad, true);
    assert.deepEqual(d.ProgramArguments.slice(3), ['run', dir, '--accept', 'node --test && echo "<ok>"', '--no-desktop']); // 특수문자가 그대로 살아 있다
    assert.equal(d.StandardOutPath, path.join(dir, '.loop-ai', 'service.log'));
  }
});
