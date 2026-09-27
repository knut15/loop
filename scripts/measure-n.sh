#!/bin/sh
# 동시 실행 수 N 에 따라 완료 시간이 줄어드는지 잰다 (합의안의 첫 검증 목표 후반).
# 서로 독립인 작업 4개를 git 프로젝트에서 돌리고, N 마다 걸린 시간·병합 충돌·재작업 수를 센다.
# 실제 모델을 부르므로 비용이 든다. 사용법: MODE=independent|conflict sh scripts/measure-n.sh claude|codex [N 목록]
# conflict: 작업 4개가 모두 같은 파일(shared.txt)에 한 줄씩 덧붙인다. 병렬로 돌리면 병합 충돌이 난다
# FILES=1: conflict 작업에 고칠 파일(--files shared.txt)을 적는다. 겹치는 작업은 동시에 돌지 않는다
set -eu
KIND=${1:-claude}
shift || true
NS=${*:-1 2 4}
MODE=${MODE:-independent}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
L() { node --disable-warning=ExperimentalWarning "$ROOT/src/cli.ts" "$@"; }

for N in $NS; do
  P=$(mktemp -d "/tmp/loopai-n$N-XXXX")
  (cd "$P" && git init -q -b main && git config user.email t@e.com && git config user.name t && echo base > README && git add . && git commit -qm init)
  if [ "$KIND" = claude ]; then L init "$P" --adapter claude --model haiku >/dev/null; else L init "$P" --adapter codex >/dev/null; fi
  L review "$P" off >/dev/null
  for i in 1 2 3 4; do
    if [ "$MODE" = conflict ]; then
      L add "$P" "f$i" --prompt "Append one line with exactly the text F$i to the end of shared.txt (create shared.txt if it does not exist). Keep existing lines. Do nothing else." --verify "grep -qx F$i shared.txt" ${FILES:+--files shared.txt} >/dev/null
    else
      L add "$P" "f$i" --prompt "Create a file named f$i.txt containing exactly the text F$i. Do nothing else." --verify "test -f f$i.txt" >/dev/null
    fi
  done
  if [ "$MODE" = conflict ]; then ACCEPT='[ "$(sort shared.txt | tr -d "\n")" = "F1F2F3F4" ]'; else ACCEPT='for i in 1 2 3 4; do test -f f$i.txt || exit 1; done'; fi
  start=$(date +%s)
  # N 마다 5분 상한. 멈춘 작업이 사람을 기다리면 run 은 끝나지 않으므로 여기서 끊는다
  perl -e 'alarm 300; exec @ARGV' node --disable-warning=ExperimentalWarning "$ROOT/src/cli.ts" run "$P" --accept "$ACCEPT" --max "$N" --interval 1000 --stall-minutes 5 --no-desktop >/dev/null 2>&1 || true
  end=$(date +%s)
  if [ "$MODE" = conflict ]; then
    merged=$(cd "$P" && git show loop-ai/main:shared.txt 2>/dev/null | grep -c '^F[1-4]$' || true)
  else
    merged=$(cd "$P" && git ls-tree --name-only loop-ai/main | grep -c '^f[1-4].txt$' || true)
  fi
  conflicts=$(L status "$P" | grep -c '병합 충돌' || true)
  rework=$(L status "$P" | grep -c ' rework:' || true)
  accepted=$(L status "$P" | grep -c 'acceptance_passed' || true)
  echo "[$MODE${FILES:+ files}] N=$N 걸린 시간 $((end - start))초, 병합된 결과 $merged/4, 병합 충돌 $conflicts, 재작업 $rework, 인수 검증 통과 $accepted ($P)"
done
