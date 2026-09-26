import { acquireManagerLock, LockHeldError } from '../../src/lock.ts';

// 관리자 잠금을 쥐고 죽을 때까지 기다리는 자식 프로세스
try {
  acquireManagerLock(process.argv[2]!);
  console.log('ACQUIRED');
  setInterval(() => {}, 1000);
} catch (e) {
  if (e instanceof LockHeldError) {
    console.log('REJECTED');
    process.exit(3);
  }
  throw e;
}
