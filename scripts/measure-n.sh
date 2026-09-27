#!/bin/sh
# 동시 실행 수 N 에 따라 완료 시간이 줄어드는지 잰다 (합의안의 첫 검증 목표 후반).
# 서로 독립인 작업 4개를 git 프로젝트에서 돌리고, N 마다 걸린 시간·병합 충돌·재작업 수를 센다.
# 실제 모델을 부르므로 비용이 든다. 사용법: sh scripts/measure-n.sh claude|codex [N 목록]
set -eu
KIND=${1:-claude}
shift || true
NS=${*:-1 2 4}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
L() { node --disable-warning=ExperimentalWarning "$ROOT/src/cli.ts" "$@"; }

for N in $NS; do
  P=$(mktemp -d "/tmp/loopai-n$N-XXXX")
  (cd "$P" && git init -q -b main && git config user.email t@e.com && git config user.name t && echo base > README && git add . && git commit -qm init)
  if [ "$KIND" = claude ]; then L init "$P" --adapter claude --model haiku >/dev/null; else L init "$P" --adapter codex >/dev/null; fi
  L review "$P" off >/dev/null
  for i in 1 2 3 4; do
    L add "$P" "f$i" --prompt "Create a file named f$i.txt containing exactly the text F$i. Do nothing else." >/dev/null
  done
  start=$(date +%s)
  L run "$P" --verify 'for i in 1 2 3 4; do [ ! -e "t$i" ]; done; true' --max "$N" --interval 1000 --stall-minutes 5 >/dev/null 2>&1 || true
  end=$(date +%s)
  merged=$(cd "$P" && git ls-tree --name-only loop-ai/main | grep -c '^f[1-4].txt$' || true)
  conflicts=$(L status "$P" | grep -c '병합 충돌' || true)
  rework=$(L status "$P" | grep -c ' rework:' || true)
  echo "N=$N 걸린 시간 $((end - start))초, 병합된 파일 $merged/4, 병합 충돌 $conflicts, 재작업 $rework ($P)"
done
