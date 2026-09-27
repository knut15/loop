import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';

// 검증 명령을 실행한다.
// trusted: 사용자가 직접 넣은 명령. 그대로 돌린다
// 그 밖(LLM 총괄이 제안한 명령): 샌드박스 안에서만 돌린다. 작업 디렉터리·임시 디렉터리 밖 쓰기와 네트워크를 막는다.
//   macOS 의 sandbox-exec 를 쓴다. 쓸 수 없는 환경이면 돌리지 않고 실패로 처리한다 (fail closed)

// allow: 샌드박스에서 쓰기를 더 허용할 경로 (예: 테스트 도구의 캐시 디렉터리). 사용자가 설정으로만 정한다
export type VerifyCommand = { command: string; trusted: boolean; allow?: string[] };
export type VerifyResult = { passed: boolean; output: string };

const TIMEOUT_MS = 10 * 60_000;
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

// 검증 명령을 자기 프로세스 그룹에서 돌리고, 끝나거나 시간이 지나면 그룹 전체를 죽이는 감싸개.
// spawnSync 만 쓰면 두 가지가 문제였다. 명령이 끝나도 손자 프로세스가 출력 파이프를 쥐고 있으면 시간 상한까지 기다리고,
// 시간 상한에서는 바로 아래 자식(sh)만 죽어 손자(node --test 등)가 남는다. 실제 프로젝트에서 멈춘 http 테스트가
// 루프를 몇 분씩 세웠고, run 을 다시 띄울 때마다 남은 테스트 프로세스가 늘었다
const GROUP_RUNNER = `
const { spawn } = require('node:child_process');
const [ms, cmd, ...args] = process.argv.slice(1);
const c = spawn(cmd, args, { detached: true, stdio: 'inherit' });
const killGroup = () => { try { process.kill(-c.pid, 'SIGKILL'); } catch {} };
let timedOut = false;
const t = setTimeout(() => { timedOut = true; killGroup(); }, Number(ms));
c.on('exit', (code) => {
  clearTimeout(t);
  killGroup();
  if (timedOut) process.stderr.write('\\n검증 명령이 ' + Math.round(Number(ms) / 1000) + '초 안에 끝나지 않아 멈췄다\\n');
  process.exit(timedOut ? 124 : (code ?? 1));
});`;

export function sandboxProfile(cwd: string, allow: string[] = []): string {
  const dir = realpathSync(cwd);
  const q = (p: string) => JSON.stringify(p);
  // 허용 경로는 실제 경로로 넣는다. 아직 없는 경로는 그대로 넣는다 (도구가 처음 만들 수 있다)
  const extra = allow.map((p) => (existsSync(p) ? realpathSync(p) : p)).map((p) => ` (subpath ${q(p)})`).join('');
  // 네트워크는 막되 이 기기 안의 연결(localhost)은 허용한다. HTTP 서버를 띄워 확인하는 테스트가 막혀 멈췄다
  return `(version 1)(allow default)(deny network*)(allow network* (local ip "localhost:*") (remote ip "localhost:*"))(deny file-write*)`
    + `(allow file-write* (subpath ${q(dir)}) (subpath "/private/tmp") (subpath "/private/var/folders") (literal "/dev/null") (literal "/dev/tty")${extra})`;
}

export function sandboxAvailable(): boolean {
  return process.platform === 'darwin' && existsSync(SANDBOX_EXEC);
}

export function runVerify(v: VerifyCommand, cwd: string, timeoutMs = TIMEOUT_MS): VerifyResult {
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
    args = ['-p', sandboxProfile(cwd, v.allow), 'sh', '-c', v.command];
  }
  const r = spawnSync(process.execPath, ['-e', GROUP_RUNNER, String(timeoutMs), cmd, ...args],
    { cwd, encoding: 'utf8', timeout: timeoutMs + 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  return { passed: r.status === 0, output: output.slice(-2000) };
}
