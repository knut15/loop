import { spawn } from 'node:child_process';
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

// 검증 명령을 자기 프로세스 그룹에서 비동기로 돌린다. 명령이 끝나거나 시간이 지나면 그룹 전체를 멈춘다.
// spawnSync 로 돌렸을 때 두 가지가 문제였다. 루프가 검증이 끝날 때까지 서서 멈춤 알림·예산 확인도 돌지 않았고,
// 시간 상한에서는 바로 아래 자식(sh)만 죽어 손자(node --test 등)가 남았다. 명령이 끝났는데 손자가 출력 파이프를
// 쥐고 있으면 상한까지 기다리기도 했다. 실제 프로젝트에서 멈춘 http 테스트가 루프를 몇 분씩 세웠다
export function runVerify(v: VerifyCommand, cwd: string, timeoutMs = TIMEOUT_MS): Promise<VerifyResult> {
  let cmd: string;
  let args: string[];
  if (v.trusted) {
    cmd = 'sh';
    args = ['-c', v.command];
  } else {
    if (!sandboxAvailable()) {
      return Promise.resolve({ passed: false, output: '샌드박스(sandbox-exec)를 쓸 수 없어 총괄이 제안한 검증 명령을 돌리지 않았다' });
    }
    cmd = SANDBOX_EXEC;
    args = ['-p', sandboxProfile(cwd, v.allow), 'sh', '-c', v.command];
  }
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    c.stdout.on('data', (d: Buffer) => { out = (out + d.toString()).slice(-20_000); });
    c.stderr.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-20_000); });
    const killGroup = () => { try { process.kill(-c.pid!, 'SIGKILL'); } catch { /* 이미 없다 */ } };
    let timedOut = false;
    let code: number | null = null;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      c.stdout.destroy();
      c.stderr.destroy();
      const note = timedOut ? `\n검증 명령이 ${Math.round(timeoutMs / 1000)}초 안에 끝나지 않아 멈췄다` : '';
      resolve({ passed: !timedOut && code === 0, output: `${out}${err}${note}`.trim().slice(-2000) });
    };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);
    let grace: NodeJS.Timeout | undefined;
    c.on('error', (e) => { err += String(e); finish(); });
    c.on('exit', (n) => {
      code = n;
      // 명령이 남긴 프로세스까지 멈춘다. 그룹 밖으로 빠져나간 프로세스가 파이프를 쥐고 있어도 잠시 뒤 끝낸다
      killGroup();
      grace = setTimeout(finish, 2000);
    });
    c.on('close', finish);
  });
}
