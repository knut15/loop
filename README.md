# loop-ai

![Node.js](https://img.shields.io/badge/Node.js-24%2B-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-7.0.2-3178C6?style=flat-square&logo=typescript&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-node%3Asqlite-003B57?style=flat-square&logo=sqlite&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-11.20.0-F69220?style=flat-square&logo=pnpm&logoColor=white)

goal 프롬프트와 스펙만 주면 여러 코딩 에이전트가 프로젝트를 끝까지 만들도록 이끄는 오케스트레이터다. 에이전트가 오래 일하다 보면 관리 프로그램이 죽거나 재시작되는 일이 생긴다. 그때 같은 작업을 두 번 시키지 않고 이어 가는 것이 먼저 풀어야 할 문제라서, 지금은 그 부분(복구 계약)만 만들어 검증했다.

## 복구 계약

관리자가 에이전트에게 일을 시킨 직후 죽었다가 다시 켜져도 같은 작업이 두 번 실행되지 않게 하는 약속이다.

1. 실행하기 전에 attempt ID, request_id, 작업 디렉터리, 시작 의도를 SQLite 에 먼저 저장한다.
2. 재시작하면 request_id 로 어댑터에 실행을 다시 묻는다.
3. 어댑터가 "시작된 적 없다"고 확인해 주면 한 번 시작한다. 확인할 수 없으면 `launch_unknown` 으로 남기고 다시 시작하지 않는다.

외부 실행이 정확히 한 번 일어난다고 보장하지 않는다. 이벤트는 최소 한 번 전달하고, 중복은 억제하고, 상태를 알 수 없으면 조사한다.

## 멈추면 알린다

작업이 멈췄는데 아무도 모르는 상태를 허용하지 않는다. 관리자는 멈춘 곳을 처음 발견한 순간 사용자에게 보고서를 보낸다. 같은 멈춤은 다시 보내지 않는다.

| 멈춘 이유 | 관리자 동작 |
| --- | --- |
| 작업자가 종료 코드 없이 사라짐 (프로세스도 기록도 없음) | 재시도하지 않고 알린다. 사람이 확인해 `resolveUnknown` 으로 판정한다 |
| 작업자가 시작됐는지 알 수 없음 (`launch_unknown`) | 같다 |
| 사용자 결정 대기 | 무엇을 입력해야 하는지(`answerDecision`) 알린다 |

보고서에는 멈춘 곳, 작업별 상태, 최근 히스토리, 다음에 할 일이 들어간다. 히스토리는 SQLite 의 `history` 표에 쌓인다. 알림 수단을 주지 않으면 표준 오류로 보고서를 남긴다.

## 무엇으로 만들었나

| 파일 | 역할 |
| --- | --- |
| `src/manager.ts` | 상태를 쓰는 유일한 곳. 상태 버전으로 오래된 제안을 거절하고, 한 작업에 살아 있는 시도를 1개로 제한한다 |
| `src/lock.ts` | 관리자를 하나만 띄운다. 별도 파일에 SQLite `EXCLUSIVE` 잠금을 걸어, 프로세스가 죽으면 OS 가 푼다 |
| `src/report.ts` | 상태 보고서. 멈춘 곳·작업·히스토리·다음에 할 일 |
| `src/adapter.ts` | 어댑터 계약 (`launch`, `lookup`) |
| `src/fake-adapter.ts` | 장애 주입용 가짜 어댑터 |
| `src/cli-adapter.ts` | 실제 Claude Code·Codex CLI 어댑터. 에이전트를 detached 로 띄워 관리자가 죽어도 계속 돌게 한다 |

SQLite 와 테스트 러너는 Node 24 에 내장된 `node:sqlite`, `node:test` 를 쓴다. TypeScript 는 타입 검사에만 쓰고, 실행은 Node 의 타입 제거 기능으로 한다.

## 돌려 보기

```bash
pnpm install
pnpm run typecheck
pnpm test
```

`pnpm test` 는 가짜 어댑터로 장애·알림 시나리오 18개를 돌린다. 관리자 잠금과 SIGKILL 재시작은 실제 자식 프로세스로 확인한다.

실제 CLI 로 확인하려면 아래를 돌린다. 실제 모델을 부르므로 비용이 들고, `claude` 또는 `codex` 가 로그인된 상태여야 한다.

```bash
pnpm run verify:cli claude   # 시나리오 5개
pnpm run verify:cli codex    # 시나리오 4개
```

## 어디까지 왔나

| 항목 | 상태 |
| --- | --- |
| 복구 계약·멈춤 알림 (가짜 어댑터) | 18개 테스트 통과 |
| 복구 계약·멈춤 알림 (실제 CLI) | Claude Code 5/5, Codex 4/4 통과 (각 1회 실행) |
| 작업자 프로세스 강제 종료 | 재시도하지 않고 한 번 알린다. 실제 CLI 로 확인 |
| 멈춤 감지 주기 | `recover()` 를 부를 때만 감지한다. 주기적으로 부르는 실행 루프는 아직 없다 |
| 총괄 에이전트, 작업 분해, 통합·인수 검증, 상태 조회 CLI | 만들지 않음 |
