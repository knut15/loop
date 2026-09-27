#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { Adapter } from './adapter.ts';
import { CliAdapter, readDenials, readOutput, readUsage, type CliKind } from './cli-adapter.ts';
import { capability, DEFAULT_ACCESS, WORKER_ACCESS, type WorkerAccess } from './policy.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { acquireManagerLock, LockHeldError } from './lock.ts';
import { inOrderCoordinator, runLoop, taskVerify, workspaceIntegrator, type Coordinator } from './loop.ts';
import { runVerify } from './verify.ts';
import { cleanAttempts, DirWorkspace, GitWorkspace, integrationSummary, INTEGRATION_BRANCH, promote, type Workspace } from './workspace.ts';
import { cliRunner } from './llm.ts';
import { llmCoordinator } from './llm-coordinator.ts';
import { llmReviewer } from './reviewer.ts';
import { makeNotify } from './notify.ts';
import { plistPath, renderPlist, serviceLabel } from './service.ts';
import { execFileSync } from 'node:child_process';
import { Manager, type ManagerOptions, type Notify, type Request } from './manager.ts';

// 프로젝트마다 <dir>/.loop-ai 아래에 상태 DB·어댑터 기록·잠금·보고서를 둔다. 잠금 경로는 여기로 고정한다.

const USAGE = `사용법:
  loop-ai init <dir> --adapter claude|codex [--model <모델>]
               [--coordinator order|llm] [--coordinator-cli claude|codex] [--coordinator-model <모델>]
               [--worker-access read-only|workspace-write|full] [--workspace dir|git]
  loop-ai policy <dir> [read-only|workspace-write|full]   (값 없이 부르면 현재 정책을 보여 준다)
  loop-ai goal <dir> <목표 문장 | @파일>
  loop-ai review <dir> [on|off] [--cli claude|codex] [--model <모델>]   (통합 전 독립 검토)
  loop-ai role <dir> [<역할 이름> <지침 파일>]   (값 없이 부르면 목록을 보여 준다)
  loop-ai budget <dir> [--minutes <분>] [--cost-usd <달러>] [--reset]   (값 없이 부르면 현재 예산과 사용량)
  loop-ai protect <dir> [<파일 패턴> ...]   (작업자가 바꾸면 병합하지 않을 파일. 값 없이 부르면 목록을 보여 준다)
  loop-ai add <dir> <작업ID> --prompt <프롬프트> [--after <작업ID,...>] [--decision <결정ID>] [--max-attempts <n>] [--role <역할>]
               [--verify <이 작업만 확인하는 명령>]
  loop-ai run <dir> [--verify <작업 기본 검증>] [--accept <전체 인수 검증>] [--max <동시 실행 수>] [--interval <ms>] [--stall-minutes <분>] [--no-desktop]
  loop-ai status <dir>
  loop-ai answer <dir> <결정ID> <스펙 버전> <응답>
  loop-ai resolve <dir> <attemptID> succeeded|failed
  loop-ai grant <dir> <작업ID> [<횟수>]
  loop-ai service <dir> plist|install|uninstall|status [-- <run 인자 ...>]
               (macOS launchd 로 run 을 띄운다. 비정상 종료 때만 다시 띄우고, 정상 완료면 멈춘다)
  loop-ai summary <dir> [--base <브랜치>]   (loop-ai/main 이 사용자 브랜치보다 더 담은 커밋·파일)
  loop-ai promote <dir> [--into <브랜치>]   (loop-ai/main 을 체크아웃된 사용자 브랜치에 병합한다. push 는 하지 않는다)
  loop-ai clean <dir> [--yes]               (끝난 시도의 worktree·기록을 지운다. --yes 없이는 목록만)
  loop-ai sandbox <dir> [allow <경로> ...]  (총괄이 제안한 검증 명령의 샌드박스에서 쓰기를 더 허용할 경로)
  loop-ai cancel <dir> <작업ID> [<이유>]   (더는 필요 없는 ready·blocked 작업을 치운다)`;

type Config = {
  adapter: CliKind | 'fake'; model?: string;
  // order: 추가된 순서대로 실행하는 규칙 기반 총괄. llm: goal 을 읽고 작업을 나누는 LLM 총괄
  coordinator?: { kind: 'order' } | { kind: 'llm'; cli: CliKind; model?: string };
  // 작업자 권한 정책. 없으면 기본값(workspace-write)
  workerAccess?: WorkerAccess;
  // dir: 작업자마다 빈 디렉터리. git: 프로젝트의 git worktree 를 받고 loop-ai/main 에 병합한다
  workspace?: 'dir' | 'git';
  // 보호할 파일 패턴 (인수 테스트 등). git 작업 공간에서만 쓴다
  protect?: string[];
  // 통합 전 독립 검토. 없으면 git 작업 공간일 때만 켠다
  review?: { enabled: boolean; cli?: CliKind; model?: string };
  // 역할 이름 → 지침 파일 경로. dispatch 때 파일 내용을 작업 프롬프트 앞에 붙인다
  roles?: Record<string, string>;
  // 총괄이 제안한 검증 명령의 샌드박스에서 쓰기를 더 허용할 경로 (테스트 도구 캐시 등)
  sandboxAllow?: string[];
};

function loadRoles(cfg: Config): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, file] of Object.entries(cfg.roles ?? {})) {
    if (!existsSync(file)) throw new Error(`역할 ${name} 의 지침 파일이 없다: ${file}`);
    out[name] = readFileSync(file, 'utf8');
  }
  return out;
}

function workspaceOf(dir: string, cfg: Config): Workspace {
  if (cfg.workspace === 'git') {
    const ws = new GitWorkspace(path.resolve(dir), paths(dir).root, cfg.protect ?? []);
    ws.init();
    return ws;
  }
  return new DirWorkspace(path.resolve(dir));
}

function loadConfig(dir: string): Config {
  return JSON.parse(readFileSync(paths(dir).config, 'utf8')) as Config;
}

const paths = (dir: string) => {
  const root = path.join(path.resolve(dir), '.loop-ai');
  return {
    root,
    config: path.join(root, 'config.json'),
    db: path.join(root, 'state.db'),
    adapter: path.join(root, 'adapter.json'),
    lock: path.join(root, 'manager.lock'),
    status: path.join(root, 'STATUS.md'),
    // 작업자의 작업 디렉터리는 프로젝트 밖에 둔다. 프로젝트 안(.loop-ai/work)에 두었더니 작업자가 경로를 보고
    // 상위 디렉터리를 프로젝트로 짐작해 원래 저장소 파일을 읽으려다 거절당했다
    work: path.join(homedir(), '.loop-ai', 'work', serviceLabel(dir)),
  };
};

function open(dir: string, notify?: Notify, mopts?: ManagerOptions): Manager {
  const p = paths(dir);
  if (!existsSync(p.config)) throw new Error(`${p.root} 가 없다. 먼저 loop-ai init 을 돌린다`);
  const cfg = loadConfig(dir);
  let adapter: Adapter;
  if (cfg.adapter === 'fake') {
    // 테스트용: 실행하자마자 성공으로 끝난다
    const f = new FakeAdapter(p.adapter);
    f.autoResult = 'succeeded';
    adapter = f;
  } else {
    adapter = new CliAdapter(cfg.adapter, p.adapter, cfg.model, cfg.workerAccess ?? DEFAULT_ACCESS);
  }
  return new Manager(p.db, adapter, p.work, notify, mopts);
}

// 상태를 바꾸는 명령. 요청함에 넣고, 루프가 돌고 있으면 루프가 다음 tick 에 반영한다.
// 루프가 없으면 잠금을 잡고 그 자리에서 반영한다. 어느 쪽이든 상태를 고치는 것은 잠금을 쥔 쪽 하나다
function submit(dir: string, req: Request, done: string): number {
  const m = open(dir);
  try {
    const seq = m.enqueue(req);
    let lock;
    try {
      lock = acquireManagerLock(paths(dir).lock);
    } catch (e) {
      if (!(e instanceof LockHeldError)) throw e;
      console.log(`루프가 실행 중이다. 요청 #${seq} 를 넣었고 다음 tick 에 반영된다 (거절되면 히스토리에 남는다)`);
      return 0;
    }
    try {
      m.applyRequests();
    } finally {
      lock.close();
    }
    const r = m.request(seq);
    if (r?.status === 'rejected') throw new Error(`요청 거절: ${r.result}`);
    console.log(done);
    return 0;
  } finally {
    m.close();
  }
}

async function main(argv: string[]): Promise<number> {
  const [cmd, dir, ...rest] = argv;
  if (!cmd || !dir) {
    console.error(USAGE);
    return 2;
  }
  const p = paths(dir);

  if (cmd === 'init') {
    const { values } = parseArgs({
      args: rest,
      options: {
        adapter: { type: 'string' }, model: { type: 'string' },
        coordinator: { type: 'string', default: 'order' }, 'coordinator-cli': { type: 'string' }, 'coordinator-model': { type: 'string' },
        'worker-access': { type: 'string', default: DEFAULT_ACCESS },
        workspace: { type: 'string' },
      },
    });
    const kind = values.adapter as Config['adapter'];
    if (!['claude', 'codex', 'fake'].includes(kind)) throw new Error('--adapter 는 claude 또는 codex 다');
    if (existsSync(p.config)) throw new Error(`이미 초기화됐다: ${p.root}`);
    const workerAccess = values['worker-access'] as WorkerAccess;
    // 대상이 git 저장소 최상위면 기본으로 worktree 방식을 쓴다
    const workspace = (values.workspace ?? (GitWorkspace.isRepo(dir) ? 'git' : 'dir')) as 'dir' | 'git';
    if (workspace !== 'dir' && workspace !== 'git') throw new Error('--workspace 는 dir 또는 git 이다');
    if (workspace === 'git' && !GitWorkspace.isRepo(dir)) throw new Error(`${dir} 는 git 저장소 최상위가 아니다`);
    if (!WORKER_ACCESS.includes(workerAccess)) throw new Error(`--worker-access 는 ${WORKER_ACCESS.join('|')} 다`);
    let coordinator: Config['coordinator'] = { kind: 'order' };
    if (values.coordinator === 'llm') {
      const cli = (values['coordinator-cli'] ?? (kind === 'fake' ? undefined : kind)) as CliKind | undefined;
      if (cli !== 'claude' && cli !== 'codex') throw new Error('--coordinator-cli 는 claude 또는 codex 다');
      coordinator = { kind: 'llm', cli, model: values['coordinator-model'] ?? values.model };
    } else if (values.coordinator !== 'order') {
      throw new Error('--coordinator 는 order 또는 llm 이다');
    }
    mkdirSync(p.root, { recursive: true });
    const review = { enabled: workspace === 'git' && kind !== 'fake' };
    writeFileSync(p.config, JSON.stringify({ adapter: kind, model: values.model, coordinator, workerAccess, workspace, review }, null, 2));
    if (kind === 'fake') FakeAdapter.init(p.adapter);
    else CliAdapter.init(kind, p.adapter, values.model, workerAccess);
    if (workerAccess === 'full') console.error('경고: 작업자 권한이 full 이다. 작업자가 파일·명령·네트워크를 제한 없이 쓴다');
    open(dir).close();
    if (workspace === 'git') {
      workspaceOf(dir, { adapter: kind, workspace });
      console.log(`작업 공간: git worktree. 결과는 ${INTEGRATION_BRANCH} 브랜치에 병합한다 (사용자 브랜치는 건드리지 않는다)`);
    }
    console.log(`초기화: ${p.root}`);
    return 0;
  }

  if (cmd === 'policy') {
    const cfg = loadConfig(dir);
    const level = rest[0] as WorkerAccess | undefined;
    if (!level) {
      console.log(`작업자 권한: ${cfg.workerAccess ?? DEFAULT_ACCESS}`);
      return 0;
    }
    if (!WORKER_ACCESS.includes(level)) throw new Error(`정책은 ${WORKER_ACCESS.join('|')} 중 하나다`);
    const before = cfg.workerAccess ?? DEFAULT_ACCESS;
    writeFileSync(p.config, JSON.stringify({ ...cfg, workerAccess: level }, null, 2));
    const m = open(dir);
    try {
      m.noteCoordinator('policy_changed', `작업자 권한 ${before} → ${level}`);
    } finally {
      m.close();
    }
    if (level === 'full') console.error('경고: 작업자 권한이 full 이다. 작업자가 파일·명령·네트워크를 제한 없이 쓴다');
    console.log(`작업자 권한: ${before} → ${level}. 설정 파일에 기록했다. 실행 중인 run 에는 적용되지 않고, run 을 다시 띄우면 적용된다`);
    return 0;
  }

  if (cmd === 'review') {
    const cfg = loadConfig(dir);
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { cli: { type: 'string' }, model: { type: 'string' } } });
    const state = positionals[0];
    if (!state) {
      const r = cfg.review;
      console.log(`검토: ${r?.enabled ? '켜짐' : '꺼짐'}${r?.enabled ? ` (${r.cli ?? cfg.adapter}${r.model ?? cfg.model ? `, ${r.model ?? cfg.model}` : ''})` : ''}`);
      return 0;
    }
    if (state !== 'on' && state !== 'off') throw new Error('review <dir> on|off');
    const cli = values.cli as CliKind | undefined;
    if (cli && cli !== 'claude' && cli !== 'codex') throw new Error('--cli 는 claude 또는 codex 다');
    const review = { enabled: state === 'on', cli: cli ?? cfg.review?.cli, model: values.model ?? cfg.review?.model };
    writeFileSync(p.config, JSON.stringify({ ...cfg, review }, null, 2));
    const m = open(dir);
    try {
      m.noteCoordinator('review_changed', `검토 ${state}`);
    } finally {
      m.close();
    }
    console.log(`검토: ${state === 'on' ? '켜짐' : '꺼짐'}`);
    return 0;
  }

  if (cmd === 'role') {
    const cfg = loadConfig(dir);
    const [name, file] = rest;
    if (!name) {
      console.log(Object.entries(cfg.roles ?? {}).map(([n, f]) => `${n}\t${f}`).join('\n') || '(역할 없음)');
      return 0;
    }
    if (!file || !existsSync(file)) throw new Error('role <dir> <역할 이름> <지침 파일>. 파일이 있어야 한다');
    if (!/^[a-z0-9][a-z0-9:_-]{0,60}$/.test(name)) throw new Error(`역할 이름 형식이 아니다: ${name}`);
    writeFileSync(p.config, JSON.stringify({ ...cfg, roles: { ...(cfg.roles ?? {}), [name]: path.resolve(file) } }, null, 2));
    console.log(`역할 등록: ${name} ← ${path.resolve(file)}`);
    return 0;
  }

  if (cmd === 'budget') {
    const { values } = parseArgs({ args: rest, options: { minutes: { type: 'string' }, 'cost-usd': { type: 'string' }, reset: { type: 'boolean' } } });
    if (values.minutes || values['cost-usd'] || values.reset) {
      submit(dir, {
        kind: 'budget',
        maxMinutes: values.minutes ? Number(values.minutes) : undefined,
        maxCostUsd: values['cost-usd'] ? Number(values['cost-usd']) : undefined,
        reset: values.reset,
      }, '예산 기록');
    }
    const m = open(dir);
    try {
      const b = m.budget();
      const u = m.usageTotals();
      console.log(`예산: 경과 시간 상한 ${b.maxMinutes ?? '-'}분, 비용 상한 $${b.maxCostUsd ?? '-'}`);
      console.log(`사용량: 비용 $${u.costUsd.toFixed(4)} (${u.costKnown}회), 비용 모름 ${u.costUnknown}회, 토큰 입력 ${u.inputTokens} · 출력 ${u.outputTokens}`);
    } finally {
      m.close();
    }
    return 0;
  }

  if (cmd === 'protect') {
    const cfg = loadConfig(dir);
    if (rest.length === 0) {
      console.log((cfg.protect ?? []).join('\n') || '(보호된 파일 없음)');
      return 0;
    }
    if (cfg.workspace !== 'git') throw new Error('보호는 git 작업 공간에서만 쓴다');
    const protect = [...new Set([...(cfg.protect ?? []), ...rest])];
    writeFileSync(p.config, JSON.stringify({ ...cfg, protect }, null, 2));
    const m = open(dir);
    try {
      m.noteCoordinator('protect_changed', `보호 파일: ${protect.join(', ')}`);
    } finally {
      m.close();
    }
    console.log(`보호 파일: ${protect.join(', ')}`);
    return 0;
  }

  if (cmd === 'goal') {
    const text = rest.join(' ');
    if (!text) throw new Error('goal <dir> <목표 문장 | @파일>');
    const goal = text.startsWith('@') ? readFileSync(text.slice(1), 'utf8') : text;
    return submit(dir, { kind: 'goal', goal }, '목표 기록');
  }

  if (cmd === 'add') {
    const { values, positionals } = parseArgs({
      args: rest, allowPositionals: true,
      options: {
        prompt: { type: 'string' }, after: { type: 'string' }, decision: { type: 'string' }, 'max-attempts': { type: 'string' },
        role: { type: 'string' }, verify: { type: 'string' },
      },
    });
    const id = positionals[0];
    if (!id || !values.prompt) throw new Error('작업ID 와 --prompt 가 필요하다');
    if (values.role && !loadConfig(dir).roles?.[values.role]) throw new Error(`없는 역할: ${values.role}. 먼저 loop-ai role 로 등록한다`);
    return submit(dir, {
      kind: 'add', id,
      opts: {
        prompt: values.prompt,
        decision: values.decision,
        dependsOn: values.after ? values.after.split(',') : [],
        maxAttempts: values['max-attempts'] ? Number(values['max-attempts']) : undefined,
        role: values.role,
        verify: values.verify,
        verifySource: 'user',
      },
    }, `작업 추가: ${id}`);
  }

  if (cmd === 'run') {
    const { values } = parseArgs({
      args: rest,
      options: {
        verify: { type: 'string' }, accept: { type: 'string' }, max: { type: 'string', default: '2' }, interval: { type: 'string', default: '5000' },
        'stall-minutes': { type: 'string', default: '15' }, 'no-desktop': { type: 'boolean' },
      },
    });
    // 작업별 검증(--verify 또는 add --verify)과 전체 인수 검증(--accept) 가운데 하나는 있어야 한다
    if (!values.verify && !values.accept) throw new Error('--verify 나 --accept 가 필요하다. 검증 없이 done 으로 옮기지 않는다');
    // LLM 총괄은 작업별 검증을 스스로 제안해서 느슨할 수 있다. 목표 전체를 확인하는 인수 검증을 반드시 둔다
    if (loadConfig(dir).coordinator?.kind === 'llm' && !values.accept) {
      throw new Error('LLM 총괄을 쓸 때는 --accept 가 필요하다. 총괄이 제안한 작업별 검증만으로는 목표 전체를 확인할 수 없다');
    }
    const lock = acquireManagerLock(p.lock); // 프로세스가 끝날 때까지 쥐고 있는다
    // STATUS.md·표준 오류에 보고서를 남기고, macOS 면 데스크톱 알림도 띄운다 (기기 밖으로는 보내지 않는다)
    const notify: Notify = makeNotify(p.status, { desktop: !values['no-desktop'] });
    const cfg = loadConfig(dir);
    const ws = workspaceOf(dir, cfg);
    const m = open(dir, notify, { stallAfterMs: Number(values['stall-minutes']) * 60_000, prepareWorkdir: (a) => ws.prepare(a) });
    let coordinator: Coordinator = inOrderCoordinator;
    const workerKind = cfg.adapter === 'fake' ? undefined : cfg.adapter;
    if (cfg.coordinator?.kind === 'llm') {
      if (!m.goal()) throw new Error('LLM 총괄은 목표가 필요하다. 먼저 loop-ai goal 을 돌린다');
      const cap = `${ws.description} ${workerKind ? capability(workerKind, cfg.workerAccess ?? DEFAULT_ACCESS) : ''}`.trim();
      coordinator = llmCoordinator(cliRunner(cfg.coordinator.cli, cfg.coordinator.model, undefined, (u) => m.recordUsage('coordinator', u)), () => {
        const out: Record<string, string> = {};
        for (const t of m.tasks().filter((x) => x.state === 'done')) {
          const a = m.lastSucceeded(t.id);
          const text = a && workerKind ? readOutput(workerKind, a.workdir) : undefined;
          if (text !== undefined) out[t.id] = text;
        }
        return out;
      }, cap);
    }
    const ac = new AbortController();
    process.once('SIGINT', () => ac.abort());
    process.once('SIGTERM', () => ac.abort());
    try {
      const r = await runLoop(m, {
        coordinator,
        readDenials: cfg.adapter === 'fake' ? undefined : (a) => readDenials(cfg.adapter as CliKind, a.workdir),
        reviewer: cfg.review?.enabled && cfg.adapter !== 'fake'
          ? llmReviewer(cliRunner(cfg.review.cli ?? (cfg.adapter as CliKind), cfg.review.model ?? cfg.model, undefined, (u) => m.recordUsage('reviewer', u)))
          : undefined,
        changes: (a) => ws.changes(a),
        preCheck: (t, a) => runVerify(taskVerify(t, values.verify, cfg.sandboxAllow), a.workdir),
        readOutput: (a) => (workerKind ? readOutput(workerKind, a.workdir) : undefined),
        readUsage: (a) => (workerKind ? readUsage(workerKind, a.workdir) : undefined),
        roles: loadRoles(cfg),
        workerNote: ws.workerNote,
        integrator: workspaceIntegrator(ws, values.verify, cfg.sandboxAllow),
        accept: values.accept ? { command: values.accept, run: () => ws.accept({ command: values.accept!, trusted: true }) } : undefined,
        maxConcurrent: Number(values.max),
        intervalMs: Number(values.interval),
        signal: ac.signal,
        onTick: (mm) => writeFileSync(p.status, mm.report()),
      });
      writeFileSync(p.status, m.report());
      console.log(`루프 종료: ${r.status} (tick ${r.ticks}회). 보고서: ${p.status}`);
      return r.status === 'done' ? 0 : 130;
    } finally {
      m.close();
      lock.close();
    }
  }

  if (cmd === 'status') {
    const m = open(dir);
    try {
      console.log(m.report());
    } finally {
      m.close();
    }
    return 0;
  }

  if (cmd === 'answer') {
    const [id, version, answer] = rest;
    if (!id || !version || answer === undefined) throw new Error('answer <dir> <결정ID> <스펙 버전> <응답>');
    return submit(dir, { kind: 'answer', id, version: Number(version), answer }, `응답 기록: ${id}`);
  }

  if (cmd === 'resolve') {
    const [attemptId, verdict] = rest;
    if (!attemptId || (verdict !== 'succeeded' && verdict !== 'failed')) throw new Error('resolve <dir> <attemptID> succeeded|failed');
    return submit(dir, { kind: 'resolve', attemptId, verdict }, `판정 기록: ${attemptId} → ${verdict}`);
  }

  if (cmd === 'service') {
    const [action, ...more] = rest;
    const sep = more.indexOf('--');
    const runArgs = sep >= 0 ? more.slice(sep + 1) : [];
    const plist = plistPath(dir);
    const label = serviceLabel(dir);
    const uid = process.getuid?.() ?? 0;
    if (action === 'plist' || action === 'install') {
      if (!runArgs.includes('--verify') && !runArgs.includes('--accept')) throw new Error('run 인자에 --verify 나 --accept 가 필요하다. 예: service <dir> install -- --accept "pnpm test"');
      const xml = renderPlist({ projectDir: dir, runArgs, node: process.execPath, cli: path.resolve(process.argv[1]!), pathEnv: process.env.PATH ?? '/usr/bin:/bin' });
      if (action === 'plist') {
        process.stdout.write(xml);
        return 0;
      }
      // 설치는 사용자 환경을 바꾸는 일이다 (~/Library/LaunchAgents 에 쓰고 launchd 에 등록). 사용자가 직접 부를 때만 한다
      mkdirSync(path.dirname(plist), { recursive: true });
      writeFileSync(plist, xml);
      execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plist], { stdio: 'inherit' });
      console.log(`등록: ${label} (${plist}). 로그: ${path.join(paths(dir).root, 'service.log')}`);
      return 0;
    }
    if (action === 'uninstall') {
      try {
        execFileSync('launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'inherit' });
      } catch { /* 이미 내려가 있으면 넘어간다 */ }
      console.log(`해제: ${label}. 설정 파일은 남겨 두었다: ${plist}`);
      return 0;
    }
    if (action === 'status') {
      try {
        const out = execFileSync('launchctl', ['print', `gui/${uid}/${label}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        console.log(out.split('\n').filter((l) => /state =|pid =|last exit code|runs =/.test(l)).map((l) => l.trim()).join('\n'));
      } catch {
        console.log(`등록되지 않았다: ${label}`);
      }
      return 0;
    }
    throw new Error('service <dir> plist|install|uninstall|status');
  }

  if (cmd === 'summary' || cmd === 'promote') {
    const cfg = loadConfig(dir);
    if (cfg.workspace !== 'git') throw new Error(`${cmd} 는 git 작업 공간에서만 쓴다`);
    const { values } = parseArgs({ args: rest, options: { base: { type: 'string' }, into: { type: 'string' } } });
    const repo = path.resolve(dir);
    const branch = values.into ?? values.base ?? execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    if (cmd === 'summary') {
      const s = integrationSummary(repo, branch);
      console.log(`${INTEGRATION_BRANCH} 이 ${branch} 보다 더 담은 커밋:\n${s.commits || '(없음)'}\n\n파일 변경:\n${s.stat || '(없음)'}`);
      return 0;
    }
    const sha = promote(repo, branch);
    console.log(`${INTEGRATION_BRANCH} 를 ${branch} 에 병합했다: ${sha.slice(0, 7)}. push 는 하지 않았다`);
    return 0;
  }

  if (cmd === 'clean') {
    const yes = rest.includes('--yes');
    const cfg = loadConfig(dir);
    // 루프가 돌고 있으면 정리하지 않는다. 쓰고 있는 작업 디렉터리를 지울 수 있다
    let lock;
    try {
      lock = acquireManagerLock(p.lock);
    } catch (e) {
      if (e instanceof LockHeldError) throw new Error('루프가 실행 중이다. 멈춘 뒤 정리한다');
      throw e;
    }
    const m = open(dir);
    try {
      const r = cleanAttempts(cfg.workspace === 'git' ? path.resolve(dir) : undefined, m.allAttempts(), !yes);
      if (r.removed.length) console.log(r.removed.join('\n'));
      if (r.skipped.length) console.log(`남긴 것:\n${r.skipped.join('\n')}`);
      console.log(yes ? `정리함: ${r.removed.length}건, 남김: ${r.skipped.length}건` : `정리할 것: ${r.removed.length}건. 지우려면 --yes 를 붙인다`);
    } finally {
      m.close();
      lock.close();
    }
    return 0;
  }

  if (cmd === 'sandbox') {
    const cfg = loadConfig(dir);
    const [action, ...more] = rest;
    if (!action) {
      console.log((cfg.sandboxAllow ?? []).join('\n') || '(추가로 허용한 경로 없음)');
      return 0;
    }
    if (action !== 'allow' || more.length === 0) throw new Error('sandbox <dir> allow <경로> ...');
    const sandboxAllow = [...new Set([...(cfg.sandboxAllow ?? []), ...more.map((x) => path.resolve(x))])];
    writeFileSync(p.config, JSON.stringify({ ...cfg, sandboxAllow }, null, 2));
    console.log(`샌드박스 쓰기 허용 경로: ${sandboxAllow.join(', ')}. run 을 다시 띄우면 적용된다`);
    return 0;
  }

  if (cmd === 'cancel') {
    const [taskId, ...why] = rest;
    if (!taskId) throw new Error('cancel <dir> <작업ID> [<이유>]');
    return submit(dir, { kind: 'cancel', taskId, reason: why.join(' ') || '사용자가 취소' }, `작업 취소: ${taskId}`);
  }

  if (cmd === 'grant') {
    const [taskId, n = '1'] = rest;
    if (!taskId) throw new Error('grant <dir> <작업ID> [<횟수>]');
    return submit(dir, { kind: 'grant', taskId, n: Number(n) }, `시도 ${n}회 추가: ${taskId}`);
  }

  console.error(USAGE);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(`loop-ai: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
