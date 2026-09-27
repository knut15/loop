import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Manager } from '../src/manager.ts';
import { CliAdapter, claudeSessionId, isAlive, runDir, type CliKind } from '../src/cli-adapter.ts';
import { MODEL } from './real-cli-config.ts';

// 실제 CLI 로 복구 계약을 검증한다. 관리자 프로세스를 SIGKILL 로 죽이고, 새 관리자가 request_id 로
// 실행을 다시 찾아 중복 없이 이어 가는지 확인한다. 실제 모델을 부르므로 pnpm test 와 따로 돌린다.
// 사용법: node scripts/verify-real-cli.ts <claude|codex>

const kind = process.argv[2] as CliKind;
if (kind !== 'claude' && kind !== 'codex') throw new Error('claude 또는 codex 를 지정한다');

type Result = { scenario: string; ok: boolean; detail: string };
const results: Result[] = [];

function runCrashChild(dir: string, crashAt: string): Promise<string | null> {
  const script = path.join(import.meta.dirname, 'crash-child.ts');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', script, dir, kind, crashAt], { stdio: 'inherit' });
  return new Promise((resolve) => child.once('exit', (_code, signal) => resolve(signal)));
}

// 이 request_id 로 실제 에이전트 실행이 몇 번 있었는지 CLI 자체 기록에서 센다
function countRuns(requestId: string): number {
  if (kind === 'claude') {
    const root = path.join(homedir(), '.claude', 'projects');
    return readdirSync(root).filter((d) => existsSync(path.join(root, d, `${claudeSessionId(requestId)}.jsonl`))).length;
  }
  const out = spawnSync('grep', ['-rl', `loop-ai request_id: ${requestId}`, path.join(homedir(), '.codex', 'sessions')], { encoding: 'utf8' });
  return out.stdout.split('\n').filter(Boolean).length;
}

async function waitSettled(m: Manager, timeoutMs = 180_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await m.recover();
    const [a] = m.attempts('t1');
    if (a && a.status !== 'launched' && a.status !== 'intent') return;
    await sleep(2000);
  }
  throw new Error('시간 안에 실행이 끝나지 않았다');
}

async function scenario(name: string, crashAt: string, check: (m: Manager, dir: string) => Promise<Result>): Promise<void> {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `loop-ai-${kind}-`)));
  CliAdapter.init(kind, path.join(dir, 'adapter.json'), MODEL[kind]);
  const signal = await runCrashChild(dir, crashAt);
  const m = new Manager(path.join(dir, 'state.db'), new CliAdapter(kind, path.join(dir, 'adapter.json'), MODEL[kind]), path.join(dir, 'work'));
  try {
    if (signal !== 'SIGKILL') {
      results.push({ scenario: name, ok: false, detail: `관리자가 SIGKILL 로 죽지 않았다: ${signal}` });
      return;
    }
    const r = await check(m, dir);
    results.push({ ...r, scenario: name, detail: `${r.detail} (dir: ${dir})` });
  } catch (e) {
    results.push({ scenario: name, ok: false, detail: String(e) });
  } finally {
    m.close();
  }
}

// A. 실행 직후, launched 를 기록하기 전에 관리자가 죽는다
await scenario('A. 실행 직후 관리자 SIGKILL', 'after_launch', async (m) => {
  const [before] = m.attempts('t1');
  await m.recover();
  const [afterRecover] = m.attempts('t1');
  await waitSettled(m);
  const [a] = m.attempts('t1');
  const runs = countRuns(a!.request_id);
  const ok = before!.status === 'intent' && ['launched', 'succeeded'].includes(afterRecover!.status)
    && a!.status === 'succeeded' && m.task('t1').state === 'integrating' && runs === 1;
  return { scenario: '', ok, detail: `재시작 직후 ${before!.status} → recover 뒤 ${afterRecover!.status} → 최종 ${a!.status}, task ${m.task('t1').state}, 실제 실행 ${runs}회` };
});

// B. 의도만 저장하고 어댑터를 부르기 전에 죽는다. 어댑터 기록이 없으므로 not_found → 한 번 시작
await scenario('B. 실행 전 관리자 SIGKILL', 'after_intent', async (m) => {
  const [before] = m.attempts('t1');
  const runsBefore = countRuns(before!.request_id);
  await m.recover();
  await waitSettled(m);
  const [a] = m.attempts('t1');
  const runs = countRuns(a!.request_id);
  const ok = runsBefore === 0 && a!.status === 'succeeded' && runs === 1;
  return { scenario: '', ok, detail: `재시작 전 실제 실행 ${runsBefore}회 → 최종 ${a!.status}, 실제 실행 ${runs}회` };
});

// C. 어댑터가 기록을 남긴 직후, 프로세스를 띄우기 전에 죽는다. 시작됐는지 알 수 없으므로 다시 시작하지 않는다
await scenario('C. 어댑터 기록 직후 관리자 SIGKILL', 'after_record', async (m, dir) => {
  await m.recover();
  await m.recover();
  await sleep(5000);
  const [a] = m.attempts('t1');
  const runs = countRuns(a!.request_id);
  const spawned = existsSync(path.join(runDir(path.join(dir, 'work', a!.id)), 'out.jsonl')) || isAlive(a!.request_id);
  const ok = a!.status === 'launch_unknown' && runs === 0 && !spawned;
  return { scenario: '', ok, detail: `최종 ${a!.status}, 실제 실행 ${runs}회, 프로세스 흔적 ${spawned}` };
});

// E. 작업자 프로세스가 조용히 죽는다. 관리자는 재시도하지 않고 한 번 알려야 한다
{
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `loop-ai-${kind}-lost-`)));
  const notes: string[] = [];
  const adapter = CliAdapter.init(kind, path.join(dir, 'adapter.json'), MODEL[kind]);
  const m = new Manager(path.join(dir, 'state.db'), adapter, path.join(dir, 'work'), (r) => notes.push(r));
  try {
    m.addTask('t1');
    // 끝나기 전에 죽일 수 있도록 조금 오래 걸리는 프롬프트를 준다
    const a = await m.dispatch('t1', 0, 'Count from 1 to 200, one number per line.');
    await sleep(1500);
    const line = execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' })
      .split('\n').find((l) => l.includes(`loop-ai:${a.request_id}`) && l.includes('sh -c'));
    if (!line) throw new Error('작업자 프로세스를 찾지 못했다(이미 끝났을 수 있다)');
    process.kill(-Number(line.trim().split(/\s+/)[0]), 'SIGKILL'); // 셸 래퍼와 CLI 를 프로세스 그룹째 죽인다
    await sleep(1500);
    await m.recover();
    await m.recover();
    const [after] = m.attempts('t1');
    const ok = notes.length === 1 && /종료 코드 없이 사라졌거나/.test(notes[0]!) && /resolveUnknown/.test(notes[0]!)
      && after!.status === 'launched' && !existsSync(path.join(runDir(a.workdir), 'exit_code')) && countRuns(a.request_id) <= 1;
    results.push({ scenario: 'E. 작업자 프로세스 SIGKILL', ok, detail: `알림 ${notes.length}회, 시도 ${after!.status}/${after!.last_lookup}, 다시 시작 없음 (dir: ${dir})` });
    if (notes[0]) console.log(notes[0]);
  } catch (e) {
    results.push({ scenario: 'E. 작업자 프로세스 SIGKILL', ok: false, detail: String(e) });
  } finally {
    m.close();
  }
}

// D. Claude 는 같은 session id 로 다시 실행하면 CLI 가 스스로 거절하는지 확인한다
if (kind === 'claude') {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'loop-ai-claude-dup-')));
  const sid = crypto.randomUUID();
  const args = ['-p', '--session-id', sid, '--model', MODEL.claude!, 'Reply with exactly: OK'];
  const first = spawnSync('claude', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const second = spawnSync('claude', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const ok = first.status === 0 && second.status !== 0 && /already in use/.test(second.stderr + second.stdout);
  results.push({ scenario: 'D. 같은 session id 재실행', ok, detail: `첫 실행 exit ${first.status}, 두 번째 exit ${second.status}: ${(second.stderr + second.stdout).trim().slice(0, 120)}` });
}

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.scenario}  —  ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${kind}: ${results.length - failed} 통과 / ${failed} 실패`);
process.exit(failed ? 1 : 0);
