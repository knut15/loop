// 사용자에게 보내는 상태 보고서. 멈춘 곳, 작업 상태, 최근 히스토리, 다음에 할 일을 한 번에 보여 준다.

export type Attention = { key: string; taskId: string | null; reason: string; next: string };
export type HistoryEntry = { at: string; task_id: string | null; attempt_id: string | null; kind: string; detail: string };

type ReportInput = {
  at: string;
  tasks: { id: string; state: string; version: number }[];
  runnable: string[];
  attention: Attention[];
  history: HistoryEntry[];
  usage?: { costUsd: number; costKnown: number; costUnknown: number; inputTokens: number; outputTokens: number };
  budget?: { maxMinutes?: number; maxCostUsd?: number; startedAt?: number };
  now?: number;
};

export function renderReport({ at, tasks, runnable, attention, history, usage, budget, now }: ReportInput): string {
  const lines: string[] = [`# loop-ai 상태 보고 (${at})`, ''];

  lines.push(`## 멈춘 곳 (${attention.length})`, '');
  if (attention.length === 0) lines.push('없음', '');
  for (const a of attention) lines.push(`- [${a.taskId ?? '-'}] ${a.reason}`);
  if (attention.length) lines.push('');

  lines.push('## 작업', '', '| 작업 | 상태 | 버전 |', '| --- | --- | --- |');
  for (const t of tasks) lines.push(`| ${t.id} | ${t.state} | ${t.version} |`);
  lines.push('');

  if (usage) {
    lines.push('## 사용량', '');
    lines.push(`- 기록된 비용: $${usage.costUsd.toFixed(4)} (${usage.costKnown}회)`);
    if (usage.costUnknown) lines.push(`- 비용을 모르는 호출: ${usage.costUnknown}회 (Codex 는 토큰 수만 준다)`);
    lines.push(`- 토큰: 입력 ${usage.inputTokens}, 출력 ${usage.outputTokens}`);
    if (budget?.maxMinutes !== undefined || budget?.maxCostUsd !== undefined) {
      const min = budget.startedAt !== undefined && now !== undefined ? Math.floor((now - budget.startedAt) / 60_000) : '-';
      lines.push(`- 예산: 경과 ${min}분 / 상한 ${budget.maxMinutes ?? '-'}분, 비용 상한 $${budget.maxCostUsd ?? '-'}`);
    }
    lines.push('');
  }

  lines.push(`## 최근 히스토리 (${history.length})`, '');
  for (const h of history) {
    lines.push(`- ${h.at} ${h.task_id ?? '-'} ${h.kind}: ${h.detail}`);
  }
  lines.push('');

  lines.push('## 다음에 할 일', '');
  const next = attention.map((a) => a.next);
  const ready = runnable;
  const integrating = tasks.filter((t) => t.state === 'integrating').map((t) => t.id);
  if (ready.length) next.push(`실행 가능한 작업을 dispatch 한다: ${ready.join(', ')}`);
  if (integrating.length) next.push(`통합·인수 검증을 돌린다: ${integrating.join(', ')}`);
  if (next.length === 0) next.push(tasks.length && tasks.every((t) => t.state === 'done' || t.state === 'cancelled') ? '모든 작업이 끝났다' : '실행 중인 작업이 끝나기를 기다린다');
  next.forEach((n, i) => lines.push(`${i + 1}. ${n}`));

  return lines.join('\n');
}
