import type { LlmRunner } from './llm.ts';
import type { Coordinator, Plan, Proposal, Snapshot } from './loop.ts';

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
        required: ['kind', 'task_id', 'prompt', 'depends_on', 'blocked_by', 'expected_version', 'decision_id', 'question', 'role'],
        properties: {
          kind: { type: 'string', enum: ['add_task', 'dispatch', 'ask_user'] },
          task_id: nullableString,
          prompt: nullableString,
          depends_on: { type: ['array', 'null'], items: { type: 'string' } },
          blocked_by: nullableString,
          expected_version: { type: ['integer', 'null'] },
          decision_id: nullableString,
          question: nullableString,
          role: nullableString,
        },
      },
    },
  },
} as const;

type RawProposal = {
  kind: string; task_id: string | null; prompt: string | null; depends_on: string[] | null;
  blocked_by: string | null; expected_version: number | null; decision_id: string | null; question: string | null;
  role?: string | null;
};
type RawPlan = { reasoning: string; goal_complete: boolean; proposals: RawProposal[] };

export function buildPrompt(s: Snapshot & { outputs: Record<string, string>; capability?: string }): string {
  const view = {
    goal: s.goal,
    capacity: s.capacity,
    runnable: s.runnable,
    tasks: s.tasks.map((t) => ({
      id: t.id, state: t.state, version: t.version,
      depends_on: t.depends_on ? t.depends_on.split(',') : [], blocked_by: t.blocked_by,
      attempts: s.attempts[t.id] ?? 0, max_attempts: t.max_attempts,
      prompt: t.prompt.slice(0, 300), role: t.role ?? null,
      result: s.outputs[t.id],
    })),
    decisions: s.decisions,
    roles: s.roles ?? [],
    recent_history: s.history.map((h) => `${h.task_id ?? '-'} ${h.kind}: ${h.detail}`),
  };
  return `You are the coordinator of loop-ai, an orchestrator that drives coding-agent workers until a goal is done.
You only decide. You never do the work yourself. Reply with a plan that matches the JSON schema.

How workers run:
- Each task runs one coding-agent CLI invocation in its own empty directory, with no memory of other tasks.
- A worker sees only its task prompt. If a task needs another task's result, make it depend on that task. When you dispatch it later, put the complete prompt in "prompt" with the needed result copied in from "result". Otherwise set "prompt" to null on dispatch to use the stored prompt.
- ${s.capability ?? 'Workers cannot create or edit files or run commands. They can only reply with text.'} Ask only for what workers can do.
- A task is verified by a command after it finishes. Only verified tasks become "done".

Rules:
1. Plan: break the goal into the fewest small, self-contained tasks. Use kind "add_task" with task_id (lowercase-kebab, max 40 chars), prompt, depends_on (ids that already exist or are added earlier in this same plan).
2. Do not invent product intent. If something only the user can decide blocks progress (stack or service with cost, unclear product behaviour), use kind "ask_user" with decision_id and one clear question written in Korean, and add the dependent tasks with blocked_by set to that decision_id. At most one question per plan. Do not ask about things you can reasonably decide.
3. Dispatch: use kind "dispatch" only for ids in "runnable", at most "capacity" of them, with expected_version equal to that task's current version. Tasks you add in this plan are not runnable yet; dispatch them in the next plan.
4. Never re-add an existing task id. If a task keeps failing (attempts near max_attempts), add a new task with a revised prompt instead of repeating the same one.
5. Set goal_complete to true only when every task is done and their results satisfy the goal. Otherwise false.
6. If "roles" is not empty, set "role" on add_task to the role that fits the task best, or null. Use only listed role names.
7. Fill unused fields with null. Keep reasoning to one or two sentences.

Current state (JSON):
${JSON.stringify(view, null, 2)}`;
}

function toProposal(p: RawProposal): Proposal {
  if (p.kind === 'add_task') {
    return {
      kind: 'add_task', id: p.task_id ?? '', prompt: p.prompt ?? '', dependsOn: p.depends_on ?? [],
      blockedBy: p.blocked_by ?? undefined, role: p.role ?? undefined,
    };
  }
  if (p.kind === 'dispatch') {
    return { kind: 'dispatch', taskId: p.task_id ?? '', expectedVersion: p.expected_version ?? -1, prompt: p.prompt ?? undefined };
  }
  if (p.kind === 'ask_user') return { kind: 'ask_user', decisionId: p.decision_id ?? '', question: p.question ?? '' };
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
