# loop-ai

![Node.js](https://img.shields.io/badge/Node.js-24%2B-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-7.0.2-3178C6?style=flat-square&logo=typescript&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-node%3Asqlite-003B57?style=flat-square&logo=sqlite&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-11.20.0-F69220?style=flat-square&logo=pnpm&logoColor=white)

goal 프롬프트와 스펙만 주면 여러 코딩 에이전트가 프로젝트를 끝까지 만들도록 이끄는 오케스트레이터다. 에이전트가 오래 일하다 보면 관리 프로그램이 죽거나 재시작되는 일이 생긴다. 그때 같은 작업을 두 번 시키지 않고 이어 가는 것이 먼저 풀어야 할 문제라서, 지금은 그 부분(복구 계약)만 만들어 검증했다.

## 써 보기

```bash
pnpm install
pnpm loop-ai init ./my-project --adapter claude --model haiku   # 또는 --adapter codex
pnpm loop-ai add  ./my-project a --prompt "..."
pnpm loop-ai add  ./my-project b --prompt "..." --after a
pnpm loop-ai run  ./my-project --verify "pnpm test" --max 2      # 모든 작업이 done 이 될 때까지 돈다
pnpm loop-ai status ./my-project                                 # 멈춘 곳·작업·히스토리·다음에 할 일
```

`run` 은 tick 마다 재조회와 멈춤 알림, 검증, 동시 실행 상한 안의 dispatch 를 한다. 멈춘 작업만 남아도 끝나지 않고 기다린다. 다른 터미널에서 `answer`(사용자 결정), `resolve`(멈춘 시도 판정), `grant`(시도 횟수 추가)를 입력하면 다음 tick 에서 이어 간다. 상태와 보고서는 `<프로젝트>/.loop-ai/` 에 있다(`state.db`, `STATUS.md`, `manager.lock`).

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
| `src/loop.ts` | 실행 루프. `Coordinator`·`Integrator` 인터페이스와 기본 구현 |
| `src/cli.ts` | `loop-ai` 명령 (`init`·`add`·`run`·`status`·`answer`·`resolve`·`grant`) |
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

`pnpm test` 는 가짜 어댑터로 장애·알림·루프·CLI 시나리오 32개를 돌린다. 관리자 잠금과 SIGKILL 재시작은 실제 자식 프로세스로 확인한다.

실제 CLI 로 확인하려면 아래를 돌린다. 실제 모델을 부르므로 비용이 들고, `claude` 또는 `codex` 가 로그인된 상태여야 한다.

```bash
pnpm run verify:cli claude   # 시나리오 5개
pnpm run verify:cli codex    # 시나리오 4개
```

## 어디까지 왔나

| 항목 | 상태 |
| --- | --- |
| 복구 계약·멈춤 알림·루프 (가짜 어댑터) | 32개 테스트 통과 |
| 복구 계약·멈춤 알림 (실제 CLI) | Claude Code 5/5, Codex 4/4 통과 (각 1회 실행) |
| 작업자 프로세스 강제 종료 | 재시도하지 않고 한 번 알린다. 실제 CLI 로 확인 |
| 실행 루프·CLI | `run` 이 tick 마다 재조회·검증·dispatch 를 한다. 실제 Claude Code·Codex 로 작업 2개(선행 관계)를 끝까지 돌렸다 |
| 총괄 | 규칙 기반 기본 구현(실행 가능한 작업을 순서대로 제안)만 있다. LLM 총괄은 `Coordinator` 인터페이스로 붙일 자리만 있다 |
| 통합 | 작업자의 작업 디렉터리에서 `--verify` 명령을 돌려 종료 코드로만 판정한다. 프로젝트 저장소와 병합하지 않으므로 "통합된 SHA 에서 검증"이 아니다 |
| 작업 디렉터리 | 작업자는 빈 디렉터리에서 돈다. 프로젝트 worktree 를 넘겨주는 기능은 없다 |
| 작업자 권한 | CLI 를 기본 권한으로 띄우므로 Claude Code 는 파일을 고치지 못할 수 있다. 권한 정책은 아직 정하지 않았다 |
| 알림 | 동기 콜백·`STATUS.md`·표준 오류. 전달이 실패하면 다음 tick 에 다시 보낸다 |
