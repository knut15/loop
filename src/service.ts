import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

// 자동 재시작 장치 (macOS launchd 사용자 에이전트).
// 합의안의 핵심 요구: 채팅이 끝나거나 프로세스가 재시작돼도 다음 작업을 이어 갈 외부 실행 장치.
// - 비정상 종료(크래시·강제 종료)일 때만 다시 띄운다 (KeepAlive.SuccessfulExit=false). 정상 완료(exit 0)면 멈춘다
// - 로그인하면 자동으로 띄운다 (RunAtLoad)
// - 너무 자주 되살리지 않는다 (ThrottleInterval)
// 상태는 모두 SQLite 에 있으므로, 다시 뜬 run 은 복구 계약대로 중복 없이 이어 간다

export type ServiceSpec = {
  projectDir: string;
  runArgs: string[]; // run 뒤에 붙일 인자 (--accept 등)
  node: string; // node 실행 파일 경로
  cli: string; // loop-ai cli 스크립트 경로
  pathEnv: string; // claude·codex 를 찾을 PATH
};

export function serviceLabel(projectDir: string): string {
  const h = createHash('sha256').update(path.resolve(projectDir)).digest('hex').slice(0, 10);
  return `dev.loop-ai.${h}`;
}

export function plistPath(projectDir: string): string {
  return path.join(homedir(), 'Library', 'LaunchAgents', `${serviceLabel(projectDir)}.plist`);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderPlist(s: ServiceSpec): string {
  const dir = path.resolve(s.projectDir);
  const log = path.join(dir, '.loop-ai', 'service.log');
  const args = [s.node, '--disable-warning=ExperimentalWarning', s.cli, 'run', dir, ...s.runArgs, '--no-desktop'];
  const str = (v: string) => `<string>${esc(v)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${str(serviceLabel(dir))}
  <key>ProgramArguments</key>
  <array>
    ${args.map(str).join('\n    ')}
  </array>
  <key>WorkingDirectory</key>${str(dir)}
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>${str(s.pathEnv)}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key>${str(log)}
  <key>StandardErrorPath</key>${str(log)}
</dict>
</plist>
`;
}
