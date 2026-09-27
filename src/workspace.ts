import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Attempt, Task } from './manager.ts';
import { runVerify, type VerifyCommand, type VerifyResult } from './verify.ts';

// 작업자에게 넘길 작업 디렉터리를 만들고, 끝난 작업을 통합해 검증한다.
//
// DirWorkspace: 빈 디렉터리를 만들고 그 디렉터리에서 검증한다. 프로젝트가 git 저장소가 아닐 때 쓴다
// GitWorkspace: 시도마다 통합 브랜치(loop-ai/main)의 최신 상태에서 git worktree 를 만들어 넘긴다.
//   끝나면 변경을 커밋하고, 통합 worktree 에서 merge --no-commit 한 상태로 검증 명령을 돌린다.
//   통과하면 병합 커밋을 만들고, 실패하거나 충돌하면 merge --abort 로 되돌린다.
//   사용자 브랜치에는 합치지 않는다. loop-ai/main 을 어디에 합칠지는 사용자가 정한다.

// alert: 사람이 알아야 하는 통합 결과 (보호된 파일 변경 등). 루프가 멈춤으로 알린다
// conflict: 병합 충돌로 되돌렸다. 작업자 잘못이 아니라 먼저 병합된 다른 작업과 겹친 것이다
export type IntegrationResult = { passed: boolean; sha: string; note?: string; alert?: { reason: string; next: string }; conflict?: boolean };

export interface Workspace {
  // 시도의 작업 디렉터리를 만든다. 이미 있으면 그대로 둔다 (재시작 뒤 다시 불릴 수 있다)
  prepare(a: Attempt): void;
  // 끝난 시도를 통합하고 검증 명령을 돌린다
  integrate(task: Task, a: Attempt, verify: VerifyCommand): IntegrationResult;
  // 모든 작업이 끝난 뒤 전체 결과에 인수 검증을 돌린다 (git: 통합 트리, dir: 프로젝트 디렉터리)
  accept(verify: VerifyCommand): VerifyResult;
  // 검토자에게 보여 줄 변경 내용 (diff 또는 파일 목록)
  changes(a: Attempt): string;
  // 총괄에게 알려 줄 작업 디렉터리 설명
  readonly description: string;
  // 작업자에게 알려 줄 작업 디렉터리 안내. 작업 프롬프트 앞에 붙는다
  readonly workerNote: string;
}

export class DirWorkspace implements Workspace {
  readonly description = 'Each worker starts in its own empty directory.';
  readonly workerNote = 'Work in the current directory. It starts empty. Use relative paths.';
  // 인수 검증을 돌릴 디렉터리. 빈 디렉터리 방식에는 합쳐진 결과물이 없어서 프로젝트 디렉터리에서 돌린다
  readonly root: string;

  constructor(root = process.cwd()) {
    this.root = root;
  }

  accept(verify: VerifyCommand): VerifyResult {
    return runVerify(verify, this.root);
  }

  prepare(a: Attempt): void {
    mkdirSync(a.workdir, { recursive: true });
  }

  integrate(_task: Task, a: Attempt, verify: VerifyCommand): IntegrationResult {
    const r = runVerify(verify, a.workdir);
    return { passed: r.passed, sha: 'no-git', note: `작업 디렉터리 검증 (병합 없음)${r.passed ? '' : `: ${tail(r.output)}`}` };
  }

  // 작업 디렉터리의 파일과 앞부분 내용. git 이 없으니 diff 대신 결과물을 그대로 보여 준다
  changes(a: Attempt): string {
    if (!existsSync(a.workdir)) return '';
    const skip = new Set(['out.jsonl', 'err.txt', 'exit_code', 'exit_code.tmp']);
    const out: string[] = [];
    for (const name of readdirSync(a.workdir)) {
      const f = path.join(a.workdir, name);
      if (skip.has(name) || name.startsWith('.') || !statSync(f).isFile()) continue;
      out.push(`--- ${name}\n${readFileSync(f, 'utf8').slice(0, 2000)}`);
    }
    return out.join('\n');
  }
}

export const INTEGRATION_BRANCH = 'loop-ai/main';

export class GitWorkspace implements Workspace {
  readonly repo: string;
  readonly integrationDir: string;
  // 작업자가 바꾸면 안 되는 파일 패턴 (인수 테스트 등). 바꾼 변경은 병합하지 않고 알린다
  readonly protect: string[];
  // 실제 프로젝트에서 작업자가 원래 저장소 경로를 읽으려다 거절당했다. 지금 디렉터리가 프로젝트라는 것을 알려 준다
  readonly workerNote =
    'Work in the current directory. It is your own checkout of the whole project (a git worktree), '
    + 'so the project files are already here. Use relative paths such as ./SPEC.md. Paths outside it are not accessible. '
    + 'Do not commit; loop-ai commits and merges your changes.';
  readonly description =
    'Each worker starts in its own git worktree of the project, checked out at the latest integrated state. ' +
    'Workers edit files there. loop-ai commits their changes and merges them after the verify command passes.';

  constructor(repo: string, loopDir: string, protect: string[] = []) {
    this.repo = repo;
    this.protect = protect;
    this.integrationDir = path.join(loopDir, 'integration');
  }

  private git(args: string[], cwd = this.repo): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  }

  static isRepo(dir: string): boolean {
    try {
      const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      // macOS 의 /tmp 처럼 링크가 낀 경로는 문자열이 달라도 같은 곳이다. 실제 경로로 비교한다
      return realpathSync(top) === realpathSync(dir);
    } catch {
      return false;
    }
  }

  // 통합 브랜치와 통합 worktree 를 준비한다. 여러 번 불러도 된다
  init(): void {
    const exclude = path.join(this.git(['rev-parse', '--git-common-dir']), 'info', 'exclude');
    const excludePath = path.isAbsolute(exclude) ? exclude : path.join(this.repo, exclude);
    // .loop-ai/ 안의 worktree 가 프로젝트의 추적 대상에 섞이지 않게 한다. 추적되는 .gitignore 는 건드리지 않는다
    mkdirSync(path.dirname(excludePath), { recursive: true });
    const current = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
    if (!current.split('\n').includes('.loop-ai/')) appendFileSync(excludePath, `${current.endsWith('\n') || !current ? '' : '\n'}.loop-ai/\n`);

    try {
      this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${INTEGRATION_BRANCH}`]);
    } catch {
      this.git(['branch', INTEGRATION_BRANCH, 'HEAD']);
    }
    if (!existsSync(this.integrationDir)) this.git(['worktree', 'add', this.integrationDir, INTEGRATION_BRANCH]);
  }

  static branchOf(a: Attempt): string {
    return `loop-ai/task/${a.task_id}-${a.id.slice(0, 8)}`;
  }

  prepare(a: Attempt): void {
    if (existsSync(a.workdir)) return;
    const base = this.git(['rev-parse', INTEGRATION_BRANCH]);
    this.git(['worktree', 'add', '-b', GitWorkspace.branchOf(a), a.workdir, base]);
  }

  // 작업자는 커밋하지 않는다 (Claude 작업자는 셸이 없다). 변경을 대신 커밋한다. 여러 번 불러도 된다
  private commitWork(a: Attempt): boolean {
    this.git(['add', '-A'], a.workdir);
    const staged = this.git(['diff', '--cached', '--name-only'], a.workdir);
    if (staged) this.git(['commit', '-q', '-m', `loop-ai: ${a.task_id} (${a.id.slice(0, 8)})`], a.workdir);
    return this.git(['rev-list', '--count', `${INTEGRATION_BRANCH}..${GitWorkspace.branchOf(a)}`]) !== '0';
  }

  changes(a: Attempt): string {
    this.commitWork(a);
    return this.git(['diff', `${INTEGRATION_BRANCH}...${GitWorkspace.branchOf(a)}`]);
  }

  accept(verify: VerifyCommand): VerifyResult {
    return runVerify(verify, this.integrationDir);
  }

  integrate(task: Task, a: Attempt, verify: VerifyCommand): IntegrationResult {
    const staged = this.commitWork(a);

    const branch = GitWorkspace.branchOf(a);
    const d = this.integrationDir;
    // 보호된 파일을 바꿨으면 병합하지 않는다. 인수 조건의 의미를 바꾸는 일은 사람이 정한다
    if (this.protect.length) {
      const changed = this.git(['diff', '--name-only', `${INTEGRATION_BRANCH}...${branch}`]).split('\n').filter(Boolean);
      const touched = changed.filter((f) => this.protect.some((g) => path.matchesGlob(f, g)));
      if (touched.length) {
        return {
          passed: false, sha: this.git(['rev-parse', 'HEAD'], d), note: `보호된 파일 변경: ${touched.join(', ')}`,
          alert: {
            reason: `작업자가 보호된 파일을 바꿔 병합하지 않았다: ${touched.slice(0, 5).join(', ')}`,
            next: `의미 변경이 필요한지 사람이 판단한다. 필요하면 브랜치 ${branch} 를 직접 검토해 반영하고, 아니면 작업 프롬프트를 고친다`,
          },
        };
      }
    }
    try {
      this.git(['merge', '--no-ff', '--no-commit', branch], d);
    } catch {
      this.abort();
      return { passed: false, sha: this.git(['rev-parse', 'HEAD'], d), note: `병합 충돌 (${branch})`, conflict: true };
    }
    // 통합된 트리에서 검증한다. 실패하면 병합 전으로 되돌린다
    const v = runVerify(verify, d);
    if (!v.passed) {
      this.abort();
      return { passed: false, sha: this.git(['rev-parse', 'HEAD'], d), note: `통합 트리 검증 실패 (${branch}): ${tail(v.output)}` };
    }
    if (this.inMerge()) this.git(['commit', '-q', '-m', `loop-ai: merge ${task.id} (${a.id.slice(0, 8)})`], d);
    return { passed: true, sha: this.git(['rev-parse', 'HEAD'], d), note: staged ? `병합 (${branch})` : '변경 없음' };
  }

  private inMerge(): boolean {
    try {
      this.git(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], this.integrationDir);
      return true;
    } catch {
      return false;
    }
  }

  private abort(): void {
    if (this.inMerge()) this.git(['merge', '--abort'], this.integrationDir);
  }
}

// 검증 출력의 마지막 부분. 히스토리에 남겨 총괄과 사람이 실패 이유를 보게 한다
function tail(output: string): string {
  return output.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300) || '(출력 없음)';
}

// ---- 반영과 정리 (사용자가 CLI 로 부를 때만 쓴다) ----

// loop-ai/main 이 사용자 브랜치보다 더 담고 있는 것
export function integrationSummary(repo: string, base: string): { commits: string; stat: string } {
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  return {
    commits: git(['log', '--oneline', '--no-merges', `${base}..${INTEGRATION_BRANCH}`]),
    stat: git(['diff', '--stat', `${base}...${INTEGRATION_BRANCH}`]),
  };
}

// loop-ai/main 을 사용자 브랜치에 병합한다. 그 브랜치가 프로젝트 디렉터리에 체크아웃돼 있고 작업 트리가 깨끗할 때만.
// 충돌하면 merge --abort 로 되돌린다. push 는 하지 않는다
export function promote(repo: string, target: string): string {
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const current = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (current !== target) throw new Error(`${target} 가 체크아웃돼 있지 않다 (지금: ${current}). 체크아웃한 뒤 다시 부른다`);
  const dirty = git(['status', '--porcelain', '--untracked-files=no']);
  if (dirty) throw new Error(`작업 트리에 커밋하지 않은 변경이 있다. 정리한 뒤 다시 부른다:\n${dirty}`);
  try {
    git(['merge', '--no-ff', '-m', `loop-ai: ${INTEGRATION_BRANCH} 반영`, INTEGRATION_BRANCH]);
  } catch (e) {
    try { git(['merge', '--abort']); } catch { /* 병합 상태가 아니면 넘어간다 */ }
    throw new Error(`병합 충돌로 되돌렸다. 직접 병합해 해결한다: git merge ${INTEGRATION_BRANCH}\n${e instanceof Error ? e.message : String(e)}`);
  }
  return git(['rev-parse', 'HEAD']);
}

// 끝난 시도의 작업 디렉터리와 기록을 지운다. dryRun 이면 목록만 돌려준다.
// 강제 옵션은 쓰지 않는다: 커밋되지 않은 변경이 남은 worktree 는 git 이 거절하므로 건너뛰고 알린다.
// 작업 브랜치(loop-ai/task/*)는 지우지 않는다. 병합되지 않은 브랜치를 지우려면 강제 삭제가 필요하고, 그건 사용자가 정한다
export function cleanAttempts(repo: string | undefined, attempts: Attempt[], dryRun: boolean): { removed: string[]; skipped: string[] } {
  const removed: string[] = [];
  const skipped: string[] = [];
  for (const a of attempts) {
    if (a.status === 'intent' || a.status === 'launched' || a.status === 'launch_unknown') continue; // 살아 있거나 알 수 없는 시도는 건드리지 않는다
    const run = `${a.workdir}.run`;
    const targets = [a.workdir, run].filter((p) => existsSync(p));
    if (!targets.length) continue;
    const label = `${a.task_id}/${a.id.slice(0, 8)}`;
    if (dryRun) {
      removed.push(`${label}: ${targets.join(', ')}`);
      continue;
    }
    if (existsSync(a.workdir)) {
      if (repo) {
        try {
          execFileSync('git', ['worktree', 'remove', a.workdir], { cwd: repo, stdio: ['ignore', 'ignore', 'pipe'] });
        } catch {
          skipped.push(`${label}: 커밋되지 않은 변경이 있어 남겼다 (${a.workdir})`);
          continue;
        }
      } else {
        rmSync(a.workdir, { recursive: true });
      }
    }
    if (existsSync(run)) rmSync(run, { recursive: true });
    removed.push(`${label}: ${targets.join(', ')}`);
  }
  return { removed, skipped };
}
