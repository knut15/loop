import path from 'node:path';
import { Manager, SimulatedCrash } from '../../src/manager.ts';
import { FakeAdapter } from '../../src/fake-adapter.ts';

// dispatch 도중 프로세스를 SIGKILL 로 죽인다. finally·exit 핸들러가 돌지 않는 실제 크래시에 가깝다
const [dir, crashAt] = process.argv.slice(2) as [string, 'after_intent' | 'after_launch'];
const m = new Manager(path.join(dir, 'state.db'), new FakeAdapter(path.join(dir, 'fake-adapter.json')), path.join(dir, 'work'));
m.addTask('t1');
try {
  await m.dispatch('t1', 0, 'build', crashAt);
} catch (e) {
  if (e instanceof SimulatedCrash) process.kill(process.pid, 'SIGKILL');
  throw e;
}
