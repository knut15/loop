#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { Adapter } from './adapter.ts';
import { CliAdapter, readOutput, type CliKind } from './cli-adapter.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { acquireManagerLock } from './lock.ts';
import { commandIntegrator, inOrderCoordinator, runLoop, type Coordinator } from './loop.ts';
import { cliRunner } from './llm.ts';
import { llmCoordinator } from './llm-coordinator.ts';
import { Manager, type ManagerOptions, type Notify } from './manager.ts';

// 프로젝트마다 <dir>/.loop-ai 아래에 상태 DB·어댑터 기록·잠금·보고서를 둔다. 잠금 경로는 여기로 고정한다.

const USAGE = `사용법:
  loop-ai init <dir> --adapter claude|codex [--model <모델>]
               [--coordinator order|llm] [--coordinator-cli claude|codex] [--coordinator-model <모델>]
  loop-ai goal <dir> <목표 문장 | @파일>
  loop-ai add <dir> <작업ID> --prompt <프롬프트> [--after <작업ID,...>] [--decision <결정ID>] [--max-attempts <n>]
  loop-ai run <dir> --verify <검증 명령> [--max <동시 실행 수>] [--interval <ms>] [--stall-minutes <분>]
  loop-ai status <dir>
  loop-ai answer <dir> <결정ID> <스펙 버전> <응답>
  loop-ai resolve <dir> <attemptID> succeeded|failed
  loop-ai grant <dir> <작업ID> [<횟수>]`;

type Config = {
  adapter: CliKind | 'fake'; model?: string;
  // order: 추가된 순서대로 실행하는 규칙 기반 총괄. llm: goal 을 읽고 작업을 나누는 LLM 총괄
  coordinator?: { kind: 'order' } | { kind: 'llm'; cli: CliKind; model?: string };
};

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
    work: path.join(root, 'work'),
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
    adapter = new CliAdapter(cfg.adapter, p.adapter, cfg.model);
  }
  return new Manager(p.db, adapter, p.work, notify, mopts);
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
      },
    });
    const kind = values.adapter as Config['adapter'];
    if (!['claude', 'codex', 'fake'].includes(kind)) throw new Error('--adapter 는 claude 또는 codex 다');
    if (existsSync(p.config)) throw new Error(`이미 초기화됐다: ${p.root}`);
    let coordinator: Config['coordinator'] = { kind: 'order' };
    if (values.coordinator === 'llm') {
      const cli = (values['coordinator-cli'] ?? (kind === 'fake' ? undefined : kind)) as CliKind | undefined;
      if (cli !== 'claude' && cli !== 'codex') throw new Error('--coordinator-cli 는 claude 또는 codex 다');
      coordinator = { kind: 'llm', cli, model: values['coordinator-model'] ?? values.model };
    } else if (values.coordinator !== 'order') {
      throw new Error('--coordinator 는 order 또는 llm 이다');
    }
    mkdirSync(p.root, { recursive: true });
    writeFileSync(p.config, JSON.stringify({ adapter: kind, model: values.model, coordinator }, null, 2));
    if (kind === 'fake') FakeAdapter.init(p.adapter);
    else CliAdapter.init(kind, p.adapter, values.model);
    open(dir).close();
    console.log(`초기화: ${p.root}`);
    return 0;
  }

  if (cmd === 'goal') {
    const text = rest.join(' ');
    if (!text) throw new Error('goal <dir> <목표 문장 | @파일>');
    const goal = text.startsWith('@') ? readFileSync(text.slice(1), 'utf8') : text;
    const m = open(dir);
    try {
      m.setGoal(goal);
    } finally {
      m.close();
    }
    console.log('목표 기록');
    return 0;
  }

  if (cmd === 'add') {
    const { values, positionals } = parseArgs({
      args: rest, allowPositionals: true,
      options: { prompt: { type: 'string' }, after: { type: 'string' }, decision: { type: 'string' }, 'max-attempts': { type: 'string' } },
    });
    const id = positionals[0];
    if (!id || !values.prompt) throw new Error('작업ID 와 --prompt 가 필요하다');
    const m = open(dir);
    try {
      if (values.decision && !m.hasDecision(values.decision)) m.openDecision(values.decision);
      m.addTask(id, {
        prompt: values.prompt,
        blockedBy: values.decision,
        dependsOn: values.after ? values.after.split(',') : [],
        maxAttempts: values['max-attempts'] ? Number(values['max-attempts']) : undefined,
      });
    } finally {
      m.close();
    }
    console.log(`작업 추가: ${id}`);
    return 0;
  }

  if (cmd === 'run') {
    const { values } = parseArgs({
      args: rest,
      options: {
        verify: { type: 'string' }, max: { type: 'string', default: '2' }, interval: { type: 'string', default: '5000' },
        'stall-minutes': { type: 'string', default: '15' },
      },
    });
    if (!values.verify) throw new Error('--verify 가 필요하다. 검증 없이 done 으로 옮기지 않는다');
    const lock = acquireManagerLock(p.lock); // 프로세스가 끝날 때까지 쥐고 있는다
    const notify: Notify = (report) => {
      writeFileSync(p.status, report);
      process.stderr.write(`\n[loop-ai] 멈춘 곳이 생겼다. ${p.status}\n\n${report}\n\n`);
    };
    const m = open(dir, notify, { stallAfterMs: Number(values['stall-minutes']) * 60_000 });
    const cfg = loadConfig(dir);
    let coordinator: Coordinator = inOrderCoordinator;
    if (cfg.coordinator?.kind === 'llm') {
      if (!m.goal()) throw new Error('LLM 총괄은 목표가 필요하다. 먼저 loop-ai goal 을 돌린다');
      const workerKind = cfg.adapter === 'fake' ? undefined : cfg.adapter;
      coordinator = llmCoordinator(cliRunner(cfg.coordinator.cli, cfg.coordinator.model), () => {
        const out: Record<string, string> = {};
        for (const t of m.tasks().filter((x) => x.state === 'done')) {
          const a = m.lastSucceeded(t.id);
          const text = a && workerKind ? readOutput(workerKind, a.workdir) : undefined;
          if (text !== undefined) out[t.id] = text;
        }
        return out;
      });
    }
    const ac = new AbortController();
    process.once('SIGINT', () => ac.abort());
    process.once('SIGTERM', () => ac.abort());
    try {
      const r = await runLoop(m, {
        coordinator,
        integrator: commandIntegrator(values.verify),
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
    const m = open(dir);
    try {
      m.answerDecision(id, Number(version), answer);
    } finally {
      m.close();
    }
    console.log(`응답 기록: ${id}`);
    return 0;
  }

  if (cmd === 'resolve') {
    const [attemptId, verdict] = rest;
    if (!attemptId || (verdict !== 'succeeded' && verdict !== 'failed')) throw new Error('resolve <dir> <attemptID> succeeded|failed');
    const m = open(dir);
    try {
      m.resolveUnknown(attemptId, verdict);
    } finally {
      m.close();
    }
    console.log(`판정 기록: ${attemptId} → ${verdict}`);
    return 0;
  }

  if (cmd === 'grant') {
    const [taskId, n = '1'] = rest;
    if (!taskId) throw new Error('grant <dir> <작업ID> [<횟수>]');
    const m = open(dir);
    try {
      m.grantAttempts(taskId, Number(n));
    } finally {
      m.close();
    }
    console.log(`시도 ${n}회 추가: ${taskId}`);
    return 0;
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
