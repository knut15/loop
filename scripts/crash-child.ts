import path from 'node:path';
import { Manager, SimulatedCrash } from '../src/manager.ts';
import { CliAdapter, type CliKind } from '../src/cli-adapter.ts';
import { MODEL, PROMPT } from './real-cli-config.ts';

// 실제 CLI 어댑터로 dispatch 하다가 관리자 프로세스를 SIGKILL 로 죽인다
const [dir, kind, crashAt] = process.argv.slice(2) as [string, CliKind, 'after_intent' | 'after_launch' | 'after_record'];
const adapter = new CliAdapter(kind, path.join(dir, 'adapter.json'), MODEL[kind]);
if (crashAt === 'after_record') adapter.crashAfterRecord = true;
const m = new Manager(path.join(dir, 'state.db'), adapter, path.join(dir, 'work'));
m.addTask('t1');
try {
  await m.dispatch('t1', 0, PROMPT, crashAt === 'after_record' ? undefined : crashAt);
} catch (e) {
  if (e instanceof SimulatedCrash) process.kill(process.pid, 'SIGKILL');
  throw e;
}
