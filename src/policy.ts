// 작업자 권한 정책. 프롬프트로 부탁하지 않고 각 CLI 가 직접 강제하는 옵션으로 옮긴다.
//
// read-only       읽고 텍스트로만 결과를 돌려준다
// workspace-write 자기 작업 디렉터리 안에서만 파일을 쓴다 (기본값)
//                 Claude: --restricted 가 파일 도구를 작업 디렉터리에 가두고, Bash 는 샌드박스 안에서만 허용한다.
//                         샌드박스는 작업 디렉터리 밖 쓰기(operation not permitted)와 네트워크를 막는다 (실험으로 확인)
//                 Codex: OS 샌드박스가 작업 디렉터리·임시 디렉터리 밖 쓰기와 네트워크를 막는다
// full            제한 없음. 사용자가 직접 켤 때만 쓴다
//
// 기본값이 workspace-write 인 이유: 설치·push·삭제·외부 전송은 사용자 승인이 필요하다.
// 이 수준에서는 네트워크와 작업 디렉터리 밖 쓰기가 CLI 수준에서 막혀 그런 행동이 일어날 수 없다.

export type WorkerAccess = 'read-only' | 'workspace-write' | 'full';
export const WORKER_ACCESS: WorkerAccess[] = ['read-only', 'workspace-write', 'full'];
export const DEFAULT_ACCESS: WorkerAccess = 'workspace-write';

// 작업자 격리. 사용자 환경의 MCP 서버(Notion·Slack·Gmail·브라우저·컴퓨터 조작 등)는 외부로 쓰는 통로라 붙이지 않는다.
// 실제로 격리 없이 띄운 Claude 작업자에게 MCP 도구 53개가, Codex 에는 컴퓨터 조작 MCP 가 붙어 있었다.
// Claude: --strict-mcp-config (--mcp-config 를 주지 않으면 MCP 없음). --restricted 가 사용자 설정·CLAUDE.md 도 읽지 않는다
// Codex: --ignore-user-config (MCP 가 정의된 config.toml 을 읽지 않는다. 인증은 그대로 쓴다)
const CLAUDE_ISOLATE = ['--strict-mcp-config'];
const CODEX_ISOLATE = ['--ignore-user-config'];

// Claude Code 샌드박스 설정. 샌드박스 밖으로 빠져나가는 명령은 허용하지 않는다
// allowLocalBinding: 이 기기 안에서 포트를 열고 붙는 것만 허용한다. 없으면 HTTP 서버 테스트가 EPERM 으로 막혀 작업자가
// 자기가 만든 서버를 시험하지 못했다. 바깥 연결은 그대로 막힌다 (curl https://example.com → 000)
export const CLAUDE_SANDBOX = JSON.stringify({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, network: { allowLocalBinding: true } } });

export function claudeArgs(access: WorkerAccess): string[] {
  // dontAsk: 허용 목록에 없는 도구 요청은 기다리지 않고 거절한다. 기다리면 -p 실행이 출력 없이 멈춘다
  if (access === 'read-only') return ['--restricted', ...CLAUDE_ISOLATE, '--permission-mode', 'dontAsk', '--allowedTools', 'Read', 'Glob', 'Grep', '--'];
  if (access === 'workspace-write') {
    // --restricted 는 Bash 를 없애지만 --tools 에 적으면 되살린다. 그 Bash 는 샌드박스 안에서만 돈다
    return ['--restricted', ...CLAUDE_ISOLATE, '--tools', 'Read,Edit,Write,Glob,Grep,Bash', '--settings', CLAUDE_SANDBOX,
      '--permission-mode', 'dontAsk', '--allowedTools', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', '--'];
  }
  return ['--permission-mode', 'bypassPermissions', '--'];
}

export function codexArgs(access: WorkerAccess): string[] {
  if (access === 'full') return ['--dangerously-bypass-approvals-and-sandbox'];
  return [...CODEX_ISOLATE, '-s', access];
}

// 총괄에게 알려 줄 작업자의 능력. 총괄이 할 수 없는 일을 시키지 않게 한다
export function capability(kind: 'claude' | 'codex', access: WorkerAccess): string {
  if (access === 'read-only') return 'Workers cannot create or edit files or run commands. They can only reply with text.';
  if (access === 'full') return 'Workers have unrestricted access to files, commands and the network.';
  return kind === 'claude'
    ? 'Workers can read, create and edit files and run shell commands inside their own working directory, in a sandbox. The network is blocked and writes outside the working directory are denied. Files they create are checked by the verify command.'
    : 'Workers can read, create and edit files and run shell commands inside their own working directory. The network is blocked and writes outside the working directory are denied. Files they create are checked by the verify command.';
}
