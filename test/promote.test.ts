import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cleanAttempts, GitWorkspace, integrationSummary, promote } from '../src/workspace.ts';
import type { Attempt } from '../src/manager.ts';

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'loop-ai-promote-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  execFileSync('sh', ['-c', 'git init -q -b main && git config user.email t@e.com && git config user.name t && echo base > app.txt && git add . && git commit -qm init'], { cwd: dir });
  const ws = new GitWorkspace(dir, path.join(dir, '.loop-ai'));
  ws.init();
  // 통합 브랜치에 커밋 하나를 올린다
  execFileSync('sh', ['-c', 'echo feature > feature.txt && git add . && git commit -qm feature'], { cwd: ws.integrationDir });
  return { dir, git, ws };
}
const attempt = (dir: string, id: string, status: Attempt['status']): Attempt =>
  ({ id, task_id: 't', request_id: `req-${id}`, workdir: path.join(dir, '.loop-ai', 'work', id), prompt: 'p', status, last_lookup: null });

test('P1. summary 는 통합 브랜치에만 있는 커밋과 파일을 보여 주고, promote 는 깨끗한 체크아웃 브랜치에만 병합한다', () => {
  const r = repo();
  const s = integrationSummary(r.dir, 'main');
  assert.match(s.commits, /feature/);
  assert.match(s.stat, /feature\.txt/);
  writeFileSync(path.join(r.dir, 'app.txt'), 'dirty\n');
  assert.throws(() => promote(r.dir, 'main'), /커밋하지 않은 변경/);
  r.git('checkout', '-q', 'app.txt');
  assert.throws(() => promote(r.dir, 'other'), /체크아웃돼 있지 않다/);
  promote(r.dir, 'main');
  assert.equal(readFileSync(path.join(r.dir, 'feature.txt'), 'utf8'), 'feature\n');
});

test('P2. 병합이 충돌하면 되돌리고 사용자 브랜치는 그대로 둔다', () => {
  const r = repo();
  execFileSync('sh', ['-c', 'echo mine > feature.txt && git add . && git commit -qm mine'], { cwd: r.dir });
  const before = r.git('rev-parse', 'HEAD');
  assert.throws(() => promote(r.dir, 'main'), /병합 충돌로 되돌렸다/);
  assert.equal(r.git('rev-parse', 'HEAD'), before);
  assert.equal(r.git('status', '--porcelain', '--untracked-files=no'), '');
});

test('P3. clean 은 끝난 시도만 지우고, 커밋되지 않은 변경이 남은 worktree 와 살아 있는 시도는 남긴다', () => {
  const r = repo();
  const done = attempt(r.dir, 'done0000-a', 'succeeded');
  const dirty = attempt(r.dir, 'dirty000-b', 'failed');
  const live = attempt(r.dir, 'live0000-c', 'launched');
  for (const a of [done, dirty, live]) r.ws.prepare(a);
  execFileSync('sh', ['-c', `mkdir -p '${done.workdir}.run' && echo x > '${done.workdir}.run/out.jsonl'`]);
  writeFileSync(path.join(dirty.workdir, 'wip.txt'), 'uncommitted\n');
  execFileSync('git', ['add', 'wip.txt'], { cwd: dirty.workdir });

  const dry = cleanAttempts(r.dir, [done, dirty, live], true);
  assert.equal(dry.removed.length, 2);
  assert.ok(existsSync(done.workdir), 'dry-run 은 지우지 않는다');

  const res = cleanAttempts(r.dir, [done, dirty, live], false);
  assert.equal(res.removed.length, 1);
  assert.equal(res.skipped.length, 1);
  assert.ok(!existsSync(done.workdir) && !existsSync(`${done.workdir}.run`));
  assert.ok(existsSync(dirty.workdir), '변경이 남은 worktree 는 남긴다');
  assert.ok(existsSync(live.workdir), '살아 있는 시도는 건드리지 않는다');
  const branches = r.git('branch', '--list', 'loop-ai/task/*');
  assert.doesNotMatch(branches, /t-done0000/, 'loop-ai/main 에 병합된 작업 브랜치는 지운다');
  assert.match(branches, /t-dirty000/, '남긴 worktree 의 브랜치는 그대로 둔다');
});

test('P4. loop-ai/main 에 병합되지 않은 작업 브랜치는 남기고 알린다. 작업 디렉터리는 지운다', () => {
  const r = repo();
  const merged = attempt(r.dir, 'merged00-a', 'succeeded');
  const unmerged = attempt(r.dir, 'unmerge0-b', 'failed');
  for (const a of [merged, unmerged]) r.ws.prepare(a);
  // 두 작업 모두 커밋을 하나씩 만들고, merged 만 통합 브랜치에 합친다
  execFileSync('sh', ['-c', 'echo m > m.txt && git add . && git commit -qm m'], { cwd: merged.workdir });
  execFileSync('sh', ['-c', 'echo u > u.txt && git add . && git commit -qm u'], { cwd: unmerged.workdir });
  execFileSync('git', ['merge', '-q', '--no-ff', '-m', 'merge', GitWorkspace.branchOf(merged)], { cwd: r.ws.integrationDir });

  const res = cleanAttempts(r.dir, [merged, unmerged], false);
  const branches = r.git('branch', '--list', 'loop-ai/task/*');
  assert.doesNotMatch(branches, /t-merged00/);
  assert.match(branches, /t-unmerge0/);
  assert.ok(!existsSync(merged.workdir) && !existsSync(unmerged.workdir), '작업 디렉터리는 둘 다 지운다');
  assert.equal(res.skipped.length, 1);
  assert.match(res.skipped[0]!, /병합되지 않은 브랜치라 남겼다/);

  // 다시 부르면 남은 브랜치만 다시 확인한다. 이미 지운 것은 목록에 없다
  const again = cleanAttempts(r.dir, [merged, unmerged], true);
  assert.equal(again.removed.length, 1);
  assert.match(again.removed[0]!, /브랜치 loop-ai\/task\/t-unmerge0/);
});


