import type { LlmRunner } from './llm.ts';

// 독립 검토자. 작업을 쓴 에이전트와 다른 별도 LLM 호출로, 도구 없이 변경(diff)만 보고 판정한다.
// 통합 전에 불린다. 반려하면 그 의견이 다음 시도의 프롬프트에 붙는다.

export type Verdict = { approve: boolean; issues: string[]; summary: string };
// evidence: 검토 전에 작업자의 작업 사본에서 돌린 작업별 검증 결과 (짧은 실험)
// priorIssues: 두 번째 검토자에게 주는 첫 검토자의 반려 이유. 같은 작업이 연달아 반려됐을 때만 채운다
export type ReviewInput = {
  goal: string; taskId: string; prompt: string; changes: string; output?: string;
  evidence?: string; priorIssues?: string;
};
export type Reviewer = (input: ReviewInput) => Promise<Verdict>;

export const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['approve', 'issues', 'summary'],
  properties: {
    approve: { type: 'boolean' },
    issues: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
} as const;

export function buildReviewPrompt(i: ReviewInput): string {
  return `You are an independent reviewer in loop-ai. You did not write this change. Review it before it is merged.
Reply with JSON matching the schema.

Approve only if all of these hold:
- The change does what the task asks.
- It makes no unrelated changes.
- It does not weaken, delete or skip tests or checks.
loop-ai runs the task's verify command and the final acceptance test itself after your review. Do not reject only because
the worker did not show test output; judge the change itself.
If you reject, list concrete issues the next attempt can fix. Keep the summary to one sentence.

Goal: ${i.goal || '(none)'}
Task id: ${i.taskId}
Task prompt:
${i.prompt}

${i.evidence ? `Result of running this task's verify command on the worker's checkout (an objective check):\n${i.evidence}\n\n` : ''}${i.priorIssues ? `You are the second, tie-breaking reviewer. The first reviewer rejected this attempt with the issues below. Decide independently using the changes and the verify result; approve if the issues are not real problems.\n${i.priorIssues}\n\n` : ''}Worker's final reply (may be empty):
${(i.output ?? '').slice(0, 2000)}

Changes:
${i.changes.slice(0, 20000) || '(no changes)'}`;
}

export function llmReviewer(runner: LlmRunner): Reviewer {
  return async (input) => {
    const v = (await runner(buildReviewPrompt(input), REVIEW_SCHEMA)) as Verdict;
    if (!v || typeof v.approve !== 'boolean' || !Array.isArray(v.issues)) throw new Error('검토 응답이 스키마에 맞지 않는다');
    return v;
  };
}
