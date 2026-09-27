import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// LLM 을 한 번 부르고 JSON Schema 에 맞는 결과를 받는다. 총괄처럼 판단만 하는 호출에 쓴다.
// 도구를 끄고 세션을 남기지 않는다. 실패·시간 초과·형식 위반은 throw 한다.

export type LlmRunner = (prompt: string, schema: object) => Promise<unknown>;

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} 호출이 ${timeoutMs}ms 안에 끝나지 않았다`));
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} 종료 코드 ${code}: ${err.trim().slice(0, 300)}`));
    });
  });
}

export type LlmUsage = { costUsd?: number | null; inputTokens?: number; outputTokens?: number };

// onUsage: 호출마다 사용량을 알려 준다. Claude 는 비용까지, Codex 는 토큰 수만 준다
export function cliRunner(kind: 'claude' | 'codex', model?: string, timeoutMs = 180_000, onUsage?: (u: LlmUsage) => void): LlmRunner {
  return async (prompt, schema) => {
    // 빈 임시 디렉터리에서 부른다. 프로젝트 파일을 읽거나 바꾸지 않게 하려는 것이다
    const cwd = mkdtempSync(path.join(tmpdir(), 'loop-ai-llm-'));
    if (kind === 'claude') {
      const out = await run('claude', [
        // 판단만 하는 호출이라 도구·MCP 를 모두 뗀다
        '-p', '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--output-format', 'json',
        '--json-schema', JSON.stringify(schema), ...(model ? ['--model', model] : []), '--', prompt,
      ], cwd, timeoutMs);
      const r = JSON.parse(out) as {
        is_error?: boolean; structured_output?: unknown; result?: string; total_cost_usd?: number;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      onUsage?.({ costUsd: r.total_cost_usd ?? null, inputTokens: r.usage?.input_tokens, outputTokens: r.usage?.output_tokens });
      if (r.is_error) throw new Error(`claude 오류: ${String(r.result).slice(0, 300)}`);
      if (r.structured_output === undefined) throw new Error('claude 가 structured_output 을 돌려주지 않았다');
      return r.structured_output;
    }
    const schemaPath = path.join(cwd, 'schema.json');
    writeFileSync(schemaPath, JSON.stringify(schema));
    const out = await run('codex', [
      'exec', '--json', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '-s', 'read-only',
      '--output-schema', schemaPath, ...(model ? ['-m', model] : []), prompt,
    ], cwd, timeoutMs);
    // 마지막 agent_message 가 스키마에 맞춘 JSON 이다
    let last: string | undefined;
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const ev = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string }; usage?: { input_tokens?: number; output_tokens?: number } };
      if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') last = ev.item.text;
      if (ev.type === 'turn.completed') onUsage?.({ costUsd: null, inputTokens: ev.usage?.input_tokens, outputTokens: ev.usage?.output_tokens });
    }
    if (last === undefined) throw new Error('codex 가 최종 메시지를 돌려주지 않았다');
    return JSON.parse(last);
  };
}
