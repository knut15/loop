import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readDenials, runDir } from '../src/cli-adapter.ts';

function workdirWith(lines: object[]): string {
  const w = path.join(mkdtempSync(path.join(tmpdir(), 'loop-ai-deny-')), 'w');
  mkdirSync(runDir(w), { recursive: true });
  writeFileSync(path.join(runDir(w), 'out.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));
  return w;
}

test('D1. Codex 명령 출력의 샌드박스 거절을 잡는다', () => {
  const w = workdirWith([
    { type: 'item.completed', item: { type: 'command_execution', command: "/bin/zsh -lc 'printf X > /Users/x/out.txt'", exit_code: 1, aggregated_output: 'zsh:1: operation not permitted: /Users/x/out.txt' } },
    { type: 'item.completed', item: { type: 'command_execution', command: 'ls', exit_code: 0, aggregated_output: 'a b' } },
  ]);
  assert.deepEqual(readDenials('codex', w), ["Shell(/bin/zsh -lc 'printf X > /Users/x/out.txt')"]);
});

test('D2. 명령 항목 없이 응답 문장에만 거절이 남은 경우도 잡는다 (실제 Codex 기록 형태)', () => {
  const w = workdirWith([
    { type: 'item.completed', item: { type: 'agent_message', text: 'Exit code: `1`. The shell reported `operation not permitted` for the target file.' } },
    { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
  ]);
  const d = readDenials('codex', w);
  assert.equal(d.length, 1);
  assert.match(d[0]!, /응답에 거절 언급: .*operation not permitted/);
});

test('D3. 거절이 없으면 비어 있고, Claude 는 permission_denials 를 읽는다', () => {
  assert.deepEqual(readDenials('codex', workdirWith([{ type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } }])), []);
  const w = path.join(mkdtempSync(path.join(tmpdir(), 'loop-ai-deny-')), 'w');
  mkdirSync(runDir(w), { recursive: true });
  writeFileSync(path.join(runDir(w), 'out.jsonl'), JSON.stringify({ permission_denials: [{ tool_name: 'Write', tool_input: { file_path: '/x' } }] }));
  assert.deepEqual(readDenials('claude', w), ['Write({"file_path":"/x"})']);
});

test('D4. Claude 샌드박스 Bash 거절은 응답 문장에서 잡는다', () => {
  const w = path.join(mkdtempSync(path.join(tmpdir(), 'loop-ai-deny-')), 'w');
  mkdirSync(runDir(w), { recursive: true });
  writeFileSync(path.join(runDir(w), 'out.jsonl'), JSON.stringify({ permission_denials: [], result: '- Output: `operation not permitted: /Users/x/probe.txt`' }));
  const d = readDenials('claude', w);
  assert.equal(d.length, 1);
  assert.match(d[0]!, /operation not permitted/);
});
