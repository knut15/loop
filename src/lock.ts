import { DatabaseSync } from 'node:sqlite';

// 관리자 단일 소유 잠금.
// SQLite 의 EXCLUSIVE 잠금은 OS 파일 잠금(POSIX advisory lock)이라 프로세스가 죽으면 OS 가 풀어 준다.
// 잠금 파일이 있는지나 PID 로 판단하지 않는다. 반환된 핸들을 프로세스가 끝날 때까지 쥐고 있어야 한다.
export class LockHeldError extends Error {}

export function acquireManagerLock(lockPath: string): DatabaseSync {
  const db = new DatabaseSync(lockPath);
  try {
    db.exec('PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;');
  } catch (e) {
    db.close();
    if (String(e).includes('locked')) throw new LockHeldError(`다른 관리자가 잠금을 쥐고 있다: ${lockPath}`);
    throw e;
  }
  return db;
}
