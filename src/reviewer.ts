import type { LlmRunner } from './llm.ts';

// 독립 검토자. 작업을 쓴 에이전트와 다른 별도 LLM 호출로, 도구 없이 변경(diff)만 보고 판정한다.
// 통합 전에 불린다. 반려하면 그 의견이 다음 시도의 프롬프트에 붙는다.

export type Verdict = { approve: boolean; issues: string[]; summary: string };
export type ReviewInput = { goal: string; taskId: string; prompt: string; changes: string; output?: string };
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
If you reject, list concrete issues the next attempt can fix. Keep the summary to one sentence.

Goal: ${i.goal || '(none)'}
Task id: ${i.taskId}
Task prompt:
${i.prompt}

Worker's final reply (may be empty):
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
