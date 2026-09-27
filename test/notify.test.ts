import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { desktopNotify, firstStop, makeNotify } from '../src/notify.ts';

const report = '# loop-ai 상태 보고 (t)\n\n## 멈춘 곳 (2)\n\n- [a] 작업자가 "조용히" 사라졌다\n- [b] 결정 대기\n';

test('N1. 보고서를 STATUS.md·표준 오류에 남기고, 데스크톱 알림에는 첫 멈춤 한 줄을 띄운다', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'loop-ai-notify-')), 'STATUS.md');
  const calls: string[][] = [];
  let err = '';
  makeNotify(file, { desktop: true, exec: (c, a) => { calls.push([c, ...a]); }, stderr: (s) => { err += s; } })(report);
  assert.equal(readFileSync(file, 'utf8'), report);
  assert.match(err, /멈춘 곳이 생겼다/);
  if (process.platform === 'darwin') {
    assert.equal(calls[0]![0], 'osascript');
    // 따옴표를 이스케이프해 AppleScript 가 깨지지 않게 한다
    assert.match(calls[0]![2]!, /display notification "\[a\] 작업자가 \\"조용히\\" 사라졌다 외 1건" with title "loop-ai: 멈춘 곳이 생겼다"/);
  }
});

test('N2. 데스크톱 알림이 실패해도 알림 전체는 실패로 보지 않는다', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'loop-ai-notify-')), 'STATUS.md');
  assert.doesNotThrow(() => makeNotify(file, { desktop: true, exec: () => { throw new Error('no gui'); }, stderr: () => {} })(report));
  assert.equal(desktopNotify('t', 'b', () => { throw new Error('x'); }), false);
  assert.equal(firstStop('## 멈춘 곳 (0)\n\n없음'), '멈춘 곳이 생겼다');
});
