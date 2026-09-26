import type { CliKind } from '../src/cli-adapter.ts';

// 검증용 실행은 비용을 줄이려고 짧은 프롬프트와 작은 모델을 쓴다. Codex 는 설정의 기본 모델을 쓴다
export const MODEL: Record<CliKind, string | undefined> = { claude: 'haiku', codex: undefined };
export const PROMPT = 'Reply with exactly: OK';
