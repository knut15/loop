import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';

// 검증 명령을 실행한다.
// trusted: 사용자가 직접 넣은 명령. 그대로 돌린다
// 그 밖(LLM 총괄이 제안한 명령): 샌드박스 안에서만 돌린다. 작업 디렉터리·임시 디렉터리 밖 쓰기와 네트워크를 막는다.
//   macOS 의 sandbox-exec 를 쓴다. 쓸 수 없는 환경이면 돌리지 않고 실패로 처리한다 (fail closed)

export type VerifyCommand = { command: string; trusted: boolean };
export type VerifyResult = { passed: boolean; output: string };

const TIMEOUT_MS = 10 * 60_000;
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

export function sandboxProfile(cwd: string): string {
  const dir = realpathSync(cwd);
  const q = (p: string) => JSON.stringify(p);
  return `(version 1)(allow default)(deny network*)(deny file-write*)`
    + `(allow file-write* (subpath ${q(dir)}) (subpath "/private/tmp") (subpath "/private/var/folders") (literal "/dev/null") (literal "/dev/tty"))`;
}

export function sandboxAvailable(): boolean {
  return process.platform === 'darwin' && existsSync(SANDBOX_EXEC);
}

export function runVerify(v: VerifyCommand, cwd: string): VerifyResult {
  let cmd: string;
  let args: string[];
  if (v.trusted) {
    cmd = 'sh';
    args = ['-c', v.command];
  } else {
    if (!sandboxAvailable()) {
      return { passed: false, output: '샌드박스(sandbox-exec)를 쓸 수 없어 총괄이 제안한 검증 명령을 돌리지 않았다' };
    }
    cmd = SANDBOX_EXEC;
    args = ['-p', sandboxProfile(cwd), 'sh', '-c', v.command];
  }
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  return { passed: r.status === 0, output: output.slice(-2000) };
}
