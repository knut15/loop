import type { LlmRunner } from './llm.ts';
import type { Coordinator, Plan, Proposal, Snapshot } from './loop.ts';
import { isFinished } from './manager.ts';

// LLM 총괄. 상태 스냅샷을 주고, 스키마에 맞춘 제안을 받는다. 판단만 하고 상태는 쓰지 않는다.
// 받은 제안은 루프가 하나씩 검증해 적용한다.

// OpenAI 계열 structured output 은 모든 필드가 required 여야 해서, 안 쓰는 필드는 null 로 받는다
const nullableString = { type: ['string', 'null'] };
export const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reasoning', 'goal_complete', 'proposals'],
  properties: {
    reasoning: { type: 'string' },
    goal_complete: { type: 'boolean' },
    proposals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'task_id', 'prompt', 'depends_on', 'blocked_by', 'expected_version', 'decision_id', 'question', 'role', 'verify', 'files'],
        properties: {
          kind: { type: 'string', enum: ['add_task', 'dispatch', 'ask_user', 'cancel_task'] },
          task_id: nullableString,
          prompt: nullableString,
          depends_on: { type: ['array', 'null'], items: { type: 'string' } },
          blocked_by: nullableString,
          expected_version: { type: ['integer', 'null'] },
          decision_id: nullableString,
          question: nullableString,
          role: nullableString,
          verify: nullableString,
          files: { type: ['array', 'null'], items: { type: 'string' } },
        },
      },
    },
  },
} as const;

type RawProposal = {
  kind: string; task_id: string | null; prompt: string | null; depends_on: string[] | null;
  blocked_by: string | null; expected_version: number | null; decision_id: string | null; question: string | null;
  role?: string | null;
  verify?: string | null;
  files?: string[] | null;
};
type RawPlan = { reasoning: string; goal_complete: boolean; proposals: RawProposal[] };

// 끝난 작업은 짧게 보여 준다. 총괄은 매 호출마다 전체 상태를 다시 받으므로, 끝난 작업의 긴 프롬프트·결과가
// 작업 수만큼 쌓이면 호출 비용이 커진다 (작업 50개면 한 번에 약 9만 자).
// 끝나지 않은 작업이 기대는 선행 작업은 결과를 그대로 둔다. 총괄이 그 결과를 뒤 작업 프롬프트에 옮겨 적는다
const RECENT_FINISHED = 50;
const SHORT_RESULT = 200;

export function buildPrompt(s: Snapshot & { outputs: Record<string, string>; capability?: string }): string {
  const open = s.tasks.filter((t) => !isFinished(t));
  const needed = new Set(open.flatMap((t) => (t.depends_on ? t.depends_on.split(',') : [])));
  const finished = s.tasks.filter((t) => isFinished(t));
  const shown = finished.slice(-RECENT_FINISHED);
  const view = {
    goal: s.goal,
    capacity: s.capacity,
    runnable: s.runnable,
    finished_tasks: shown.map((t) => ({
      id: t.id, state: t.state, files: t.files ? t.files.split(',') : null,
      result: needed.has(t.id) ? s.outputs[t.id] : s.outputs[t.id]?.slice(0, SHORT_RESULT),
    })),
    finished_tasks_omitted: finished.length - shown.length,
    project_files: s.project?.files ?? null,
    project_files_omitted: s.project?.filesOmitted ?? 0,
    project_docs: s.project?.docs ?? {},
    tasks: open.map((t) => ({
      id: t.id, state: t.state, version: t.version,
      depends_on: t.depends_on ? t.depends_on.split(',') : [], blocked_by: t.blocked_by,
      attempts: s.attempts[t.id] ?? 0, max_attempts: t.max_attempts,
      prompt: t.prompt.slice(0, 300), role: t.role ?? null, verify: t.verify ?? null, files: t.files ? t.files.split(',') : null, spec_version: t.spec_version ?? null,
      notes: s.notes?.[t.id],
      result: s.outputs[t.id],
    })),
    decisions: s.decisions,
    roles: s.roles ?? [],
    acceptance_command: s.acceptance ?? null,
    last_acceptance: s.lastAcceptance ?? null,
    spec_version: s.specVersion ?? null,
    recent_history: s.history.map((h) => `${h.task_id ?? '-'} ${h.kind}: ${h.detail}`),
  };
  return `You are the coordinator of loop-ai, an orchestrator that drives coding-agent workers until a goal is done.
You only decide. You never do the work yourself. Reply with a plan that matches the JSON schema.

How workers run:
- Each task runs one coding-agent CLI invocation in its own empty directory, with no memory of other tasks.
- A worker sees only its task prompt. If a task needs another task's result, make it depend on that task. When you dispatch it later, put the complete prompt in "prompt" with the needed result copied in from "result". Otherwise set "prompt" to null on dispatch to use the stored prompt.
- ${s.capability ?? 'Workers cannot create or edit files or run commands. They can only reply with text.'} Ask only for what workers can do.
- A task is verified by a command after it finishes. Only verified tasks become "done".
- "project_files" lists the files in the integrated project, and "project_docs" holds the contents of files the goal mentions. Read them instead of asking the user for their contents.
- "tasks" lists unfinished tasks in full. "finished_tasks" lists done or cancelled tasks briefly; the oldest are left out and counted in "finished_tasks_omitted". Their ids stay taken.

Rules:
1. Plan: break the goal into the fewest small, self-contained tasks. Every task must create or change files toward the goal; do not add analysis-only or planning-only tasks. Every prompt must be non-empty and say exactly what to build. Use kind "add_task" with task_id (lowercase-kebab, max 40 chars), prompt, depends_on (ids that already exist or are added earlier in this same plan).
2. Do not invent product intent. If something only the user can decide blocks progress (stack or service with cost, unclear product behaviour), use kind "ask_user" with decision_id and one clear question written in Korean, and add the dependent tasks with blocked_by set to that decision_id. At most one question per plan. Do not ask about things you can reasonably decide.
3. Dispatch: use kind "dispatch" only for ids in "runnable", at most "capacity" of them, with expected_version equal to that task's current version. Tasks you add in this plan are not runnable yet; dispatch them in the next plan.
4. Never re-add an existing task id. If a task keeps failing (attempts near max_attempts), add a new task with a revised prompt instead of repeating the same one.
5. Set goal_complete to true only when every task is done or cancelled and their results satisfy the goal. Otherwise false.
   If a ready or blocked task is no longer needed (for example an earlier plan was replaced), cancel it with kind "cancel_task" (task_id, and the reason in "prompt"). Unfinished tasks keep the loop from finishing.
6. If "roles" is not empty, set "role" on add_task to the role that fits the task best, or null. Use only listed role names.
7. Give each add_task a "verify" shell command that checks only that task's own result in the integrated project tree (for example: test -f add.sh && [ "$(sh add.sh 2 3)" = 5 ]). It must pass once this task alone is merged, even if other tasks are not done yet. It may rely only on this task's own files and on tasks listed in its depends_on. If the check needs another task's code (for example a test that imports that task's module), put that task in depends_on, or choose a check that does not need it. It runs in a sandbox with no network. Use null if there is nothing to check.
8. Each task has "notes": attempts so far, the last reviewer rejection and the last rework reason. Use them instead of repeating a failing prompt. If a task's spec_version is older than the current "spec_version", the goal has changed since it was created; cancel or replace it if it no longer fits.
9. "acceptance_command" (if set) checks the whole goal after every task is done. If "recent_history" shows acceptance_failed, add tasks that fix the failure instead of repeating finished ones.
10. Give each add_task "files": the paths (or globs such as src/api/*.js) it will create or change. Split tasks so their files do not overlap when you can; tasks whose files overlap never run at the same time, and parallel edits to one file cause merge conflicts. Use null only if you cannot tell.
11. Fill unused fields with null. Keep reasoning to one or two sentences.

Current state (JSON):
${JSON.stringify(view, null, 2)}`;
}

function toProposal(p: RawProposal): Proposal {
  if (p.kind === 'add_task') {
    return {
      kind: 'add_task', id: p.task_id ?? '', prompt: p.prompt ?? '', dependsOn: p.depends_on ?? [],
      blockedBy: p.blocked_by ?? undefined, role: p.role ?? undefined, verify: p.verify ?? undefined,
      files: p.files ?? undefined,
    };
  }
  if (p.kind === 'dispatch') {
    return { kind: 'dispatch', taskId: p.task_id ?? '', expectedVersion: p.expected_version ?? -1, prompt: p.prompt ?? undefined };
  }
  if (p.kind === 'ask_user') return { kind: 'ask_user', decisionId: p.decision_id ?? '', question: p.question ?? '' };
  if (p.kind === 'cancel_task') return { kind: 'cancel_task', taskId: p.task_id ?? '', reason: p.prompt ?? '' };
  // 모르는 종류는 그대로 넘겨 루프가 거절하게 한다
  return p as unknown as Proposal;
}

// capability: 작업자가 권한 정책상 할 수 있는 일 (policy.ts 의 capability). 총괄이 할 수 없는 일을 시키지 않게 한다
export function llmCoordinator(runner: LlmRunner, readOutputs: () => Record<string, string> = () => ({}), capability?: string): Coordinator {
  return {
    decidesCompletion: true,
    async propose(s: Snapshot): Promise<Plan> {
      const raw = (await runner(buildPrompt({ ...s, outputs: readOutputs(), capability }), PLAN_SCHEMA)) as RawPlan;
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.proposals) || typeof raw.goal_complete !== 'boolean') {
        throw new Error('총괄 응답이 스키마에 맞지 않는다');
      }
      return { proposals: raw.proposals.map(toProposal), goalComplete: raw.goal_complete, reasoning: raw.reasoning };
    },
  };
}
