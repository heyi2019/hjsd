#!/usr/bin/env bash
# restore_drill.sh —— 恢复演练：把备份/上线包恢复到临时库，跑不变量断言，验完即删。
#
# 用法：
#   bash deploy/scripts/restore_drill.sh                      # 默认演练上线包（release_latest.sha256 指向的那个）
#   bash deploy/scripts/restore_drill.sh backups/xxx.dump     # 演练指定包
#   bash deploy/scripts/restore_drill.sh <dump> "orders=119,stocks=90,users=6"   # 追加精确期望值
#
# 设计要点：
# 1) 只读演练——临时库用完必删（trap 兜底），不碰 dev/test/release 任何一库。
# 2) 不变量恒定校验（表数/版本戳/配置表/编号序列/术语/结构对代码），与数据量无关，任何包都该过。
#    其中「结构对代码」走 deploy/scripts/schema_diff.py 做列级比对——只数表个数查不出
#    「表齐但少一列」，而那正是老包配新代码上线后的典型 500 来源。
# 3) 精确值用参数传，不写死在脚本里——包内容会变，脚本不该跟着改。
# 4) 退出码：0 全过 / 1 有不变量失败 / 2 环境或前置错误。

set -euo pipefail
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin

cd "$(dirname "$0")/../.."
REPO_ROOT="$(pwd)"
CONTAINER="${ERP_PG_CONTAINER:-heijin-db-1}"
PGUSER="${ERP_PG_USER:-erp_app}"
DUMP="${1:-}"
EXPECT="${2:-}"

die() { echo "✗ $*" >&2; exit 2; }
command -v docker >/dev/null 2>&1 || die "找不到 docker（cron 下需先设 PATH）"
docker ps --format '{{.Names}}' | grep -qx "${CONTAINER}" || die "容器 ${CONTAINER} 未运行"

if [ -z "${DUMP}" ]; then
  SHA_FILE="${REPO_ROOT}/backups/release_latest.sha256"
  [ -f "${SHA_FILE}" ] || die "未指定包，且找不到 ${SHA_FILE}"
  DUMP="${REPO_ROOT}/$(awk '{print $2}' "${SHA_FILE}")"
fi
[ -f "${DUMP}" ] || die "包不存在：${DUMP}"

TS="$(date +%Y%m%d_%H%M%S)"
DB="heijin_erp_drill_${TS}"

cleanup() {
  docker exec "${CONTAINER}" psql -U "${PGUSER}" -d postgres \
    -c "DROP DATABASE IF EXISTS ${DB} WITH (FORCE);" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "=== 恢复演练 $(date '+%F %T') ==="
echo "包   : $(basename "${DUMP}")（$(wc -c < "${DUMP}" | tr -d ' ') B）"

# 有 sidecar 就校验哈希，没有则跳过（不阻断演练）
SIDECAR="${DUMP}.sha256"
if [ -f "${SIDECAR}" ]; then
  if shasum -a 256 -c "${SIDECAR}" >/dev/null 2>&1; then
    echo "哈希 : ✅ 与 sidecar 一致"
  else
    echo "哈希 : ❌ 与 sidecar 不一致，已中止" >&2
    exit 2
  fi
fi

TOC_ALL=$(docker exec -i "${CONTAINER}" pg_restore -l < "${DUMP}" | grep -cE '^[0-9]+;' || true)
TOC_DATA=$(docker exec -i "${CONTAINER}" pg_restore -l < "${DUMP}" | grep -c 'TABLE DATA' || true)
echo "TOC  : 对象 ${TOC_ALL} 条 / TABLE DATA ${TOC_DATA} 条"

docker exec "${CONTAINER}" psql -U "${PGUSER}" -d postgres \
  -c "CREATE DATABASE ${DB} OWNER ${PGUSER};" >/dev/null 2>&1 || die "建临时库失败"

echo "恢复 : --no-owner --single-transaction → ${DB}"
if ! docker exec -i "${CONTAINER}" pg_restore -U "${PGUSER}" -d "${DB}" \
      --no-owner --single-transaction < "${DUMP}" 2>/tmp/restore_drill.err; then
  echo "✗ 恢复失败，pg_restore 输出：" >&2
  tail -5 /tmp/restore_drill.err >&2
  exit 2
fi
echo "恢复 : ✅ 无错误"

REPORT=$(docker exec "${CONTAINER}" psql -U "${PGUSER}" -d "${DB}" -tAc "
select 'tables='||(select count(*) from information_schema.tables where table_schema='public')
  ||' version='||coalesce((select version_num from alembic_version),'NONE')
  ||' orders='||(select count(*) from orders)
  ||' stocks='||(select count(*) from stocks)
  ||' cashflow='||(select count(*) from cashflow)
  ||' events='||(select count(*) from order_events)
  ||' users='||(select count(*) from users)
  ||' customers='||(select count(*) from customers)
  ||' fields='||(select count(*) from order_form_fields)
  ||' optionsets='||(select count(*) from option_sets)
  ||' pools='||(select count(*) from pools)
  ||' sequences='||(select count(*) from document_sequences)
  ||' 作废残留='||(select count(*) from option_sets where options::text like '%作废%')
  ||' cancel标签='||coalesce((select string_agg(o->>'label','/')
                              from option_sets s, json_array_elements(s.options) o
                              where s.code='ORDER_EVENT_TYPE' and (o->>'value')='CANCEL'),'无');") \
  || die "统计查询失败（表结构可能与脚本假设不符）"

FAIL=0
echo "--- 不变量（任何包都该过）---"
check_eq() { # $1=键 $2=期望
  local got
  got=$(echo "${REPORT}" | tr ' ' '\n' | awk -F= -v k="$1" '$1==k{print $2}')
  if [ "${got}" = "$2" ]; then
    printf '  ✅ %-11s %s\n' "$1" "${got}"
  else
    printf '  ❌ %-11s 期望 %s，实际 %s\n' "$1" "$2" "${got:-空}"
    FAIL=1
  fi
}
check_eq tables 40
check_eq version 0001
check_eq pools 2
check_eq sequences 13
check_eq 作废残留 0
check_eq cancel标签 取消

# 第 7 项：结构必须与当前代码的 ORM 一致。表数对得上不等于列对得上，
# 老包配新代码上线后第一个读该列的请求就 500，而恢复演练原本看不见这一层。
echo "--- 结构对代码（列级）---"
PY="${REPO_ROOT}/backend/.venv/bin/python3"
if [ ! -x "${PY}" ]; then
  printf '  ❌ %-11s 找不到 %s\n' schema "${PY}"
  FAIL=1
elif "${PY}" "${REPO_ROOT}/deploy/scripts/schema_diff.py" "${DB}"; then
  printf '  ✅ %-11s 与当前 ORM 无差异\n' schema
else
  rc=$?
  if [ "${rc}" -eq 2 ]; then
    printf '  ❌ %-11s 比对无法运行（环境问题，非结构差异，见上）\n' schema
  else
    printf '  ❌ %-11s 与当前 ORM 有差异（缺列/多列/类型不符）\n' schema
  fi
  FAIL=1
fi

echo "--- 内容量 ---"
echo "${REPORT}" | tr ' ' '\n' | grep -E '^(orders|stocks|cashflow|events|users|customers|fields|optionsets)=' | sed 's/^/  /'

if [ -n "${EXPECT}" ]; then
  echo "--- 精确期望 ---"
  IFS=',' read -ra PAIRS <<< "${EXPECT}"
  for pair in "${PAIRS[@]}"; do
    check_eq "${pair%%=*}" "${pair##*=}"
  done
fi

if [ "${FAIL}" -ne 0 ]; then
  echo "=== 结论：❌ 有不变量或期望值不符 ==="
  exit 1
fi
echo "=== 结论：✅ 全部通过（临时库 ${DB} 将自动删除）==="
