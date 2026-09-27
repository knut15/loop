// 작업자 권한 정책. 프롬프트로 부탁하지 않고 각 CLI 가 직접 강제하는 옵션으로 옮긴다.
//
// read-only       읽고 텍스트로만 결과를 돌려준다
// workspace-write 자기 작업 디렉터리 안에서만 파일을 쓴다 (기본값)
//                 Claude: --restricted 가 셸·코드 실행 도구를 없애고 파일 도구를 작업 디렉터리에 가둔다
//                 Codex: OS 샌드박스가 작업 디렉터리·임시 디렉터리 밖 쓰기와 네트워크를 막는다
// full            제한 없음. 사용자가 직접 켤 때만 쓴다
//
// 기본값이 workspace-write 인 이유: 설치·push·삭제·외부 전송은 사용자 승인이 필요하다.
// 이 수준에서는 네트워크와 작업 디렉터리 밖 쓰기가 CLI 수준에서 막혀 그런 행동이 일어날 수 없다.

export type WorkerAccess = 'read-only' | 'workspace-write' | 'full';
export const WORKER_ACCESS: WorkerAccess[] = ['read-only', 'workspace-write', 'full'];
export const DEFAULT_ACCESS: WorkerAccess = 'workspace-write';

export function claudeArgs(access: WorkerAccess): string[] {
  // dontAsk: 허용 목록에 없는 도구 요청은 기다리지 않고 거절한다. 기다리면 -p 실행이 출력 없이 멈춘다
  if (access === 'read-only') return ['--restricted', '--permission-mode', 'dontAsk', '--allowedTools', 'Read', 'Glob', 'Grep', '--'];
  if (access === 'workspace-write') {
    return ['--restricted', '--permission-mode', 'dontAsk', '--allowedTools', 'Read', 'Edit', 'Write', 'Glob', 'Grep', '--'];
  }
  return ['--permission-mode', 'bypassPermissions', '--'];
}

export function codexArgs(access: WorkerAccess): string[] {
  if (access === 'full') return ['--dangerously-bypass-approvals-and-sandbox'];
  return ['-s', access];
}

// 총괄에게 알려 줄 작업자의 능력. 총괄이 할 수 없는 일을 시키지 않게 한다
export function capability(kind: 'claude' | 'codex', access: WorkerAccess): string {
  if (access === 'read-only') return 'Workers cannot create or edit files or run commands. They can only reply with text.';
  if (access === 'full') return 'Workers have unrestricted access to files, commands and the network.';
  return kind === 'claude'
    ? 'Workers can read, create and edit files only inside their own empty working directory. They cannot run shell commands or use the network. Files they create are checked by the verify command.'
    : 'Workers can read, create and edit files and run shell commands inside their own empty working directory. The network is blocked and writes outside the working directory are denied. Files they create are checked by the verify command.';
}
