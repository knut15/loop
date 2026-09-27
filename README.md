# loop-ai

![Node.js](https://img.shields.io/badge/Node.js-24%2B-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-7.0.2-3178C6?style=flat-square&logo=typescript&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-node%3Asqlite-003B57?style=flat-square&logo=sqlite&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-11.20.0-F69220?style=flat-square&logo=pnpm&logoColor=white)

goal 프롬프트와 스펙만 주면 여러 코딩 에이전트가 프로젝트를 끝까지 만들도록 이끄는 오케스트레이터다. 에이전트가 오래 일하다 보면 관리 프로그램이 죽거나 재시작되는 일이 생긴다. 그때 같은 작업을 두 번 시키지 않고 이어 가는 것이 먼저 풀어야 할 문제라서, 지금은 그 부분(복구 계약)만 만들어 검증했다.

## 써 보기

```bash
pnpm install
# LLM 총괄: goal 만 주면 총괄이 작업을 나누고 순서를 정한다
pnpm loop-ai init ./my-project --adapter claude --model haiku --coordinator llm   # 또는 --adapter codex
pnpm loop-ai goal ./my-project "만들 것을 설명한다"                                # 또는 @goal.md
pnpm loop-ai run  ./my-project --verify "pnpm test" --max 2      # 총괄이 목표 완료라고 할 때까지 돈다

# 규칙 기반 총괄(기본값): 작업을 직접 넣고, 넣은 순서대로 돈다
pnpm loop-ai init ./other --adapter claude
pnpm loop-ai add  ./other a --prompt "..."
pnpm loop-ai add  ./other b --prompt "..." --after a
pnpm loop-ai run  ./other --verify "pnpm test"
pnpm loop-ai status ./my-project                                 # 멈춘 곳·작업·히스토리·다음에 할 일
```

`run` 은 tick 마다 재조회와 멈춤 알림, 검증, 동시 실행 상한 안의 dispatch 를 한다. 멈춘 작업만 남아도 끝나지 않고 기다린다. 다른 터미널에서 `answer`(사용자 결정), `resolve`(멈춘 시도 판정), `grant`(시도 횟수 추가)를 입력하면 다음 tick 에서 이어 간다. 상태와 보고서는 `<프로젝트>/.loop-ai/` 에 있다(`state.db`, `STATUS.md`, `manager.lock`).

## 작업 공간과 통합

`init` 대상이 git 저장소 최상위면 git worktree 방식을 쓴다 (`--workspace dir|git` 으로 바꿀 수 있다).

- 시도마다 통합 브랜치 `loop-ai/main` 의 최신 상태에서 worktree 를 만들어 작업자에게 넘긴다
- 끝나면 변경을 커밋하고, 통합 worktree(`.loop-ai/integration`)에서 `merge --no-commit` 한 상태로 `--verify` 를 돌린다. 통과하면 병합 커밋을 만들고, 실패·충돌이면 `merge --abort` 로 되돌린다
- **사용자 브랜치에는 합치지 않는다.** `loop-ai/main` 을 어디에 합칠지는 사용자가 정한다
- 어댑터 기록(작업자 출력·종료 코드)은 작업 디렉터리 옆 `<workdir>.run/` 에 둔다. 작업 디렉터리 안에 두면 작업 변경으로 함께 병합됐다
- `loop-ai protect <dir> <패턴>` 으로 등록한 파일(인수 테스트 등)을 작업자가 바꾸면 병합하지 않고 알린다

## 검토와 역할

- git 작업 공간이면 기본으로 **독립 검토**를 켠다. 작업자와 다른 LLM 호출이 도구 없이 diff 만 보고 판정한다. 반려하면 의견을 다음 시도 프롬프트에 붙여 다시 돌린다. `loop-ai review <dir> on|off`
- `loop-ai role <dir> <이름> <지침 파일>` 로 역할을 등록하면, 그 역할의 작업 프롬프트 앞에 지침을 붙인다. LLM 총괄은 등록된 역할 중에서 고른다. `--restricted` 에서는 플러그인 에이전트(`--agent`)를 쓸 수 없어서 이 방식을 쓴다

## 예산과 알림

- 작업자·총괄·검토자 호출의 사용량을 기록한다. Claude 는 비용까지, Codex 는 토큰 수만 준다
- `loop-ai budget <dir> --minutes <분> --cost-usd <달러>` 에 닿으면 새 작업을 멈추고 알린다. 돌고 있는 작업자는 끝날 때까지 둔다
- 멈춤 알림은 `STATUS.md`, 표준 오류, macOS 데스크톱 알림으로 전달한다. 기기 밖으로는 보내지 않는다 (`--no-desktop` 으로 끈다)

## 상태를 바꾸는 명령

`add`·`goal`·`answer`·`resolve`·`grant`·`budget` 은 요청함에 넣기만 한다. 루프가 돌고 있으면 루프가 다음 tick 에 검증해 반영하고, 없으면 CLI 가 잠금을 잡고 바로 반영한다. 상태를 고치는 것은 늘 잠금을 쥔 쪽 하나다.

## 작업자 권한

작업자를 띄울 때 권한을 프롬프트로 부탁하지 않고, 각 CLI 가 직접 강제하는 옵션으로 막는다. `loop-ai init --worker-access` 로 정하고 `loop-ai policy <dir> <수준>` 으로 바꾼다. 바꾼 기록은 히스토리에 남는다.

| 수준 | Claude Code | Codex | 작업자가 할 수 있는 것 |
| --- | --- | --- | --- |
| `read-only` | `--restricted`, 읽기 도구만 | `-s read-only` | 읽고 텍스트로만 결과를 돌려준다 |
| `workspace-write` (기본) | `--restricted`, 파일 도구 + 샌드박스 안의 Bash | `-s workspace-write` | 자기 작업 디렉터리 안에서만 파일을 쓰고, 샌드박스 안에서 셸을 쓴다. 네트워크와 밖으로 쓰기는 막힌다 |
| `full` | `bypassPermissions` | 샌드박스 해제 | 제한 없음. 사용자가 직접 켤 때만 쓴다 |

기본값이 `workspace-write` 인 이유는 설치·push·삭제·외부 전송에 사용자 승인이 필요하기 때문이다. 이 수준에서는 네트워크와 작업 디렉터리 밖 쓰기가 CLI 수준에서 막혀서 그런 행동이 일어날 수 없다.

작업자는 사용자 환경과 격리한다. Claude 는 `--strict-mcp-config` 로 MCP 서버를 떼고(격리 없이는 Notion·Slack·Gmail 등 MCP 도구 53개가 붙어 있었다), `--restricted` 로 사용자 설정·CLAUDE.md 를 읽지 않는다. Codex 는 `--ignore-user-config` 로 MCP(컴퓨터 조작 등)가 정의된 설정을 읽지 않는다. 총괄·검토자 호출도 같다.

작업자가 권한 밖 요청을 거절당하면 멈춤 보고서로 알린다. 작업마다 한 번 알리고, 그 작업이 done 이 되면 내린다. Claude 는 `permission_denials` 와 응답 문장, Codex 는 명령 출력과 응답 문장에서 거절 문구(`operation not permitted` 등)를 찾는다. 응답 문장은 모델이 쓴 글이라 덜 확실하다.

확인한 것: Claude `--restricted` 는 작업 디렉터리 안 쓰기는 허용하고 밖 쓰기는 거절했으며, 셸 도구는 아예 없었다. Codex `workspace-write` 는 작업 디렉터리와 임시 디렉터리 밖 쓰기를 `operation not permitted` 로 막았고, 네트워크 요청(`curl`)도 실패했다. 임시 디렉터리 쓰기는 허용된다.

## LLM 총괄

`--coordinator llm` 이면 상태가 바뀔 때마다 LLM 을 한 번 부른다. goal, 작업 상태, 끝난 작업의 결과 일부, 최근 히스토리, 결정과 응답을 넘기고 JSON Schema 에 맞춘 계획을 받는다. 도구를 끄고 빈 임시 디렉터리에서 부르므로 총괄은 판단만 한다.

| 제안 | 관리자가 검증하는 것 |
| --- | --- |
| `add_task` | ID 형식, 중복, 이미 있는 선행 작업, 빈 프롬프트, 한 번에 10개·전체 50개 상한 |
| `dispatch` | 상태 버전, 실행 가능 여부, 선행 작업, 시도 상한, 동시 실행 상한. 선행 작업 결과를 옮겨 담은 프롬프트로 바꿔 실행할 수 있다 |
| `ask_user` | ID 형식, 중복, 한 번에 질문 하나. 질문은 멈춤 보고서로 사용자에게 간다 |

모든 작업이 done 이어도 총괄이 `goal_complete` 를 줘야 끝난다. 총괄 호출이 3번 연속 실패하거나, 목표 미완료라면서 다음 작업을 내지 않으면 멈춤으로 알린다. 호출 결과는 `coordinator_called` 로 히스토리에 남는다.

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
| `src/policy.ts` | 작업자 권한 정책. 수준별 CLI 옵션과 총괄에게 알릴 작업자 능력 |
| `src/workspace.ts` | 작업 공간. 빈 디렉터리 또는 git worktree, 통합·검증·보호 파일 |
| `src/reviewer.ts` | 독립 검토자 |
| `src/notify.ts` | 멈춤 알림 전달 (STATUS.md·표준 오류·데스크톱) |
| `src/llm.ts` | LLM 을 한 번 부르고 JSON Schema 에 맞춘 결과를 받는다 (Claude Code `--json-schema`, Codex `--output-schema`) |
| `src/llm-coordinator.ts` | LLM 총괄. 프롬프트와 계획 스키마 |
| `src/report.ts` | 상태 보고서. 멈춘 곳·작업·히스토리·다음에 할 일 |
| `src/adapter.ts` | 어댑터 계약 (`launch`, `lookup`) |
| `src/fake-adapter.ts` | 장애 주입용 가짜 어댑터 |
| `src/cli-adapter.ts` | 실제 Claude Code·Codex CLI 어댑터. 에이전트를 detached 로 띄워 관리자가 죽어도 계속 돌게 한다 |

SQLite 와 테스트 러너는 Node 24 에 내장된 `node:sqlite`, `node:test` 를 쓴다. TypeScript 는 타입 검사에만 쓰고, 실행은 Node 의 타입 제거 기능으로 한다.

## 설치

```bash
pnpm pack                      # loop-ai-0.1.0.tgz (dist/ 만 담긴다. prepack 이 빌드한다)
# 설치해서 쓰려면: pnpm add -g ./loop-ai-0.1.0.tgz  →  loop-ai init ...
```

Node 24 이상이 필요하다 (`node:sqlite`). 작업자로 쓸 `claude` 또는 `codex` CLI 가 설치·로그인돼 있어야 한다.

## 돌려 보기

```bash
pnpm install
pnpm run typecheck
pnpm test
```

`pnpm test` 는 가짜 어댑터와 대본대로 응답하는 가짜 LLM, 임시 git 저장소로 시나리오 70개를 돌린다. 관리자 잠금과 SIGKILL 재시작은 실제 자식 프로세스로 확인한다.

실제 CLI 로 확인하려면 아래를 돌린다. 실제 모델을 부르므로 비용이 들고, `claude` 또는 `codex` 가 로그인된 상태여야 한다.

```bash
pnpm run verify:cli claude   # 시나리오 5개
pnpm run verify:cli codex    # 시나리오 4개
```

## 어디까지 왔나

| 항목 | 상태 |
| --- | --- |
| 단위·통합 테스트 | 70개 통과 |
| 복구 계약·멈춤 알림 (실제 CLI) | Claude Code 5/5, Codex 4/4 통과 (각 1회 실행) |
| 작업자 프로세스 강제 종료 | 재시도하지 않고 한 번 알린다. 실제 CLI 로 확인 |
| 오래 끝나지 않는 작업자 | 살아 있어도 `--stall-minutes`(기본 15분)를 넘기면 알린다. 죽이거나 재시도하지 않는다 |
| 실행 루프·CLI | `run` 이 tick 마다 재조회·검증·dispatch 를 한다. 실제 Claude Code·Codex 로 작업 2개(선행 관계)를 끝까지 돌렸다 |
| 총괄 | 규칙 기반(기본)과 LLM 총괄. 실제 Claude haiku 총괄로 goal 을 작업 2개로 나누고, 앞 작업 결과를 뒤 작업 프롬프트에 옮겨 끝까지 돌렸다 |
| 통합 | 작업자의 작업 디렉터리에서 `--verify` 명령을 돌려 종료 코드로만 판정한다. 프로젝트 저장소와 병합하지 않으므로 "통합된 SHA 에서 검증"이 아니다 |
| 작업 공간 | git 프로젝트면 worktree 를 넘기고 `loop-ai/main` 에 병합한다. 실제 Claude·Codex 작업자가 프로젝트 파일을 고쳐 병합됐다 |
| 검토·역할·보호·예산·요청함 | 구현. 실제 LLM 총괄 + 검토 + 보호 + 예산을 함께 켜고 goal 을 끝까지 돌렸다 (251초, $0.63) |
| 작업별 검증 명령 | 없음. 검증 명령이 전체 인수 테스트면 먼저 끝난 작업이 혼자 통과하지 못해 재작업이 늘었다 |
| 작업자 권한 | 세 단계 정책(기본 `workspace-write`). 실제 Claude Code·Codex 작업자가 작업 디렉터리에 `hello.txt` 를 쓰고 검증을 통과했다. 밖으로 쓰려던 요청은 거절되고 알림으로 올라왔다 |
| 알림 | 동기 콜백·`STATUS.md`·표준 오류. 전달이 실패하면 다음 tick 에 다시 보낸다 |
