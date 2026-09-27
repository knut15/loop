import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Adapter, LaunchRequest, LookupResult } from './adapter.ts';
import { claudeArgs, codexArgs, DEFAULT_ACCESS, type WorkerAccess } from './policy.ts';

// 실제 코딩 에이전트 CLI 어댑터.
// 1) 프로세스를 띄우기 전에 자기 저장소에 기록을 남긴다. 그래서 기록이 없으면 not_found 를 믿을 수 있다.
// 2) 에이전트는 detached 로 띄워 관리자가 죽어도 계속 돈다. 끝나면 셸 래퍼가 종료 코드를 파일로 남긴다.
// 3) lookup 은 종료 코드 파일 → 살아 있는 프로세스 순으로 확인하고, 둘 다 없으면 unknown 이다.

export type CliKind = 'claude' | 'codex';

type Record = { kind: CliKind; workdir: string; recordedAt: string };
type Store = { [requestId: string]: Record };

// 셸 래퍼의 $0 에 넣는 표지. ps 로 살아 있는 실행을 찾을 때 쓴다
const marker = (requestId: string) => `loop-ai:${requestId}`;

// request_id 는 'req-<uuid>' 형식이다. Claude 에는 uuid 부분을 session id 로 넘긴다
export const claudeSessionId = (requestId: string) => requestId.replace(/^req-/, '');

function command(kind: CliKind, requestId: string, prompt: string, model: string | undefined, access: WorkerAccess): string[] {
  if (kind === 'claude') {
    // 권한 옵션은 policy.ts 가 정한다. 프롬프트는 '--' 뒤에 둔다 (--allowedTools 가 여러 값을 받기 때문이다)
    return ['claude', '-p', '--session-id', claudeSessionId(requestId), '--output-format', 'json',
      ...(model ? ['--model', model] : []), ...claudeArgs(access), prompt];
  }
  // Codex 는 실행 ID 를 미리 정할 수 없다. 프롬프트에 request_id 를 넣어 세션 기록에서 찾게 한다
  return ['codex', 'exec', '--json', '--skip-git-repo-check', ...codexArgs(access),
    ...(model ? ['-m', model] : []), `${prompt}\n\n(loop-ai request_id: ${requestId})`];
}

export class CliAdapter implements Adapter {
  readonly kind: CliKind;
  readonly storePath: string;
  readonly model: string | undefined;
  readonly access: WorkerAccess;
  // 장애 주입: 기록을 남긴 직후, 프로세스를 띄우기 전에 관리자 프로세스를 죽인다
  crashAfterRecord = false;

  constructor(kind: CliKind, storePath: string, model?: string, access: WorkerAccess = DEFAULT_ACCESS) {
    this.kind = kind;
    this.storePath = storePath;
    this.model = model;
    this.access = access;
  }

  static init(kind: CliKind, storePath: string, model?: string, access: WorkerAccess = DEFAULT_ACCESS): CliAdapter {
    writeFileSync(storePath, '{}');
    return new CliAdapter(kind, storePath, model, access);
  }

  private load(): Store | undefined {
    try {
      return JSON.parse(readFileSync(this.storePath, 'utf8')) as Store;
    } catch {
      return undefined;
    }
  }

  async launch(req: LaunchRequest): Promise<void> {
    const store = this.load();
    if (!store) throw new Error(`어댑터 저장소를 읽을 수 없다: ${this.storePath}`);
    mkdirSync(req.workdir, { recursive: true });
    store[req.requestId] = { kind: this.kind, workdir: req.workdir, recordedAt: new Date().toISOString() };
    writeFileSync(this.storePath, JSON.stringify(store));
    if (this.crashAfterRecord) process.kill(process.pid, 'SIGKILL');

    const argv = command(this.kind, req.requestId, req.prompt, this.model, this.access);
    // 종료 코드는 임시 파일에 쓴 뒤 mv 로 바꿔 넣어, 반쯤 쓴 파일을 읽지 않게 한다
    const script = '"$@" > out.jsonl 2> err.txt < /dev/null; echo $? > exit_code.tmp && mv exit_code.tmp exit_code';
    const child = spawn('sh', ['-c', script, marker(req.requestId), ...argv], {
      cwd: req.workdir, detached: true, stdio: 'ignore',
    });
    child.unref();
  }

  async lookup(requestId: string): Promise<LookupResult> {
    const store = this.load();
    if (!store) return 'unknown';
    const rec = store[requestId];
    if (!rec) return 'not_found';
    const exitFile = path.join(rec.workdir, 'exit_code');
    if (existsSync(exitFile)) return readFileSync(exitFile, 'utf8').trim() === '0' ? 'succeeded' : 'failed';
    if (isAlive(requestId)) return 'running';
    // 기록은 있는데 종료 코드도 프로세스도 없다: 띄우기 전에 죽었거나 래퍼가 강제 종료됐다
    return 'unknown';
  }
}

export function isAlive(requestId: string): boolean {
  const out = execFileSync('ps', ['-axww', '-o', 'command='], { encoding: 'utf8' });
  return out.split('\n').some((line) => line.startsWith(`sh -c`) && line.includes(marker(requestId)));
}

// 끝난 작업자의 최종 응답을 읽는다. 총괄이 다음 작업 프롬프트에 결과를 옮겨 담을 때 쓴다
export function readOutput(kind: CliKind, workdir: string, limit = 1000): string | undefined {
  const file = path.join(workdir, 'out.jsonl');
  if (!existsSync(file)) return undefined;
  const raw = readFileSync(file, 'utf8');
  try {
    if (kind === 'claude') return String((JSON.parse(raw) as { result?: string }).result ?? '').slice(0, limit);
    let last = '';
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const ev = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string } };
      if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') last = ev.item.text ?? '';
    }
    return last.slice(0, limit);
  } catch {
    return undefined;
  }
}

// 작업자가 권한 밖이라 거절당한 도구 요청. Claude 만 결과에 permission_denials 로 남긴다.
// Codex 샌드박스 거절은 명령 실패로만 보여서 여기서는 잡지 못한다
export function readDenials(kind: CliKind, workdir: string): string[] {
  if (kind !== 'claude') return [];
  const file = path.join(workdir, 'out.jsonl');
  if (!existsSync(file)) return [];
  try {
    const r = JSON.parse(readFileSync(file, 'utf8')) as { permission_denials?: { tool_name: string; tool_input?: unknown }[] };
    return (r.permission_denials ?? []).map((d) => `${d.tool_name}(${JSON.stringify(d.tool_input ?? {}).slice(0, 120)})`);
  } catch {
    return [];
  }
}
