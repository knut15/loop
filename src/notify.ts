import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import type { Notify } from './manager.ts';

// 멈춤 알림을 사용자에게 전달한다. 기기 밖으로 보내지 않는다.
// 1) STATUS.md 에 보고서 전체  2) 표준 오류에 보고서 전체  3) macOS 데스크톱 알림에 첫 멈춤 한 줄
// 데스크톱 알림은 보조 수단이다. 실패해도 1)·2) 가 남았으니 알림 전체를 실패로 보지 않는다.
// 1)·2) 가 실패하면 throw 해서 관리자가 alert_failed 로 남기고 다음 tick 에 다시 보내게 한다.

type Exec = (cmd: string, args: string[]) => void;
const defaultExec: Exec = (cmd, args) => { execFileSync(cmd, args, { stdio: 'ignore', timeout: 10_000 }); };

// AppleScript 문자열 안의 따옴표와 역슬래시를 이스케이프한다
const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

// 보고서의 "멈춘 곳" 첫 항목
export function firstStop(report: string): string {
  const m = /## 멈춘 곳 \((\d+)\)\s*\n\s*\n- (.+)/.exec(report);
  return m ? `${m[2]}${Number(m[1]) > 1 ? ` 외 ${Number(m[1]) - 1}건` : ''}` : '멈춘 곳이 생겼다';
}

export function desktopNotify(title: string, body: string, exec: Exec = defaultExec): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    exec('osascript', ['-e', `display notification ${q(body.slice(0, 200))} with title ${q(title)}`]);
    return true;
  } catch {
    return false;
  }
}

export function makeNotify(statusPath: string, opts: { desktop: boolean; exec?: Exec; stderr?: (s: string) => void }): Notify {
  const err = opts.stderr ?? ((s: string) => { process.stderr.write(s); });
  return (report) => {
    writeFileSync(statusPath, report);
    err(`\n[loop-ai] 멈춘 곳이 생겼다. ${statusPath}\n\n${report}\n\n`);
    if (opts.desktop) desktopNotify('loop-ai: 멈춘 곳이 생겼다', firstStop(report), opts.exec);
  };
}
