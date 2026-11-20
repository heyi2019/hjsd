#!/usr/bin/env bash
# pg_pitr_backup.sh —— PITR 两件套：WAL 归档巡检 + 物理基备。
# 本地目前已关闭 PITR，本脚本不再定时运行；以下说明仅供手动重新配置时参考。
#
# 为什么需要两件：PITR = 物理基备（回放底座）+ WAL 归档（回放增量）。
# 只有 WAL 没有基备回放不出来；只有 pg_dump 逻辑备份也不是 PITR（逻辑备份接不了
# WAL 回放）。backup_local.sh 那套 pg_dump 属于另一个维度，两者互补。
#
# 拓扑（2026-11-03 起）：库在自己的容器 heijin-db-1 里，归档目录由 compose 直接
# bind mount 到宿主机 backups/pg_wal_live/——归档段由 postgres 直接写到宿主机，
# 不再需要从容器里拷出来，也不与数据卷同盘。
#
# 用法：
#   bash deploy/scripts/pg_pitr_backup.sh wal     # 每小时：巡检归档器 + 执行保留策略
#   bash deploy/scripts/pg_pitr_backup.sh base    # 每周：pg_basebackup 物理基备
#
# 环境变量：
#   ERP_PG_CONTAINER   容器名，默认 heijin-db-1
#   ERP_PG_USER        库用户，默认 erp_app（须 rolsuper 或 rolreplication）
#   ERP_WAL_DIR        归档目录，默认 backups/pg_wal_live
#   ERP_WAL_KEEP_DAYS  归档保留天数，默认 4（2026-11-12 由 7 收紧；维持 7 天请显式设此变量）
#   ERP_BASE_KEEP      基备保留份数，默认 1（基备每周日+周三各一次=间隔 3.5 天，与 WAL 4 天窗口绑定）
#
# 退出码：0 正常 / 1 归档器异常 / 2 环境错误。

set -euo pipefail
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin

cd "$(dirname "$0")/../.."
REPO_ROOT="$(pwd)"
CONTAINER="${ERP_PG_CONTAINER:-heijin-db-1}"
PGUSER="${ERP_PG_USER:-erp_app}"
WAL_DIR="${ERP_WAL_DIR:-${REPO_ROOT}/backups/pg_wal_live}"
WAL_KEEP_DAYS="${ERP_WAL_KEEP_DAYS:-4}"
BASE_KEEP="${ERP_BASE_KEEP:-1}"
BASE_DIR="${REPO_ROOT}/backups/pg_base"
MODE="${1:-wal}"

die() { echo "✗ $*" >&2; exit 2; }
command -v docker >/dev/null 2>&1 || die "找不到 docker（cron 下需先设 PATH）"
docker ps --format '{{.Names}}' | grep -qx "${CONTAINER}" || die "容器 ${CONTAINER} 未运行"

psql_q() { docker exec "${CONTAINER}" psql -U "${PGUSER}" -d postgres -tAc "$1"; }

# archive_mode 写在 compose 的启动参数里，不是 auto.conf——但容器被人手动改过、
# 或换了个 compose 文件起，这里会第一时间报出来，而不是等要回滚那天才发现没归档。
assert_archive_on() {
  local mode
  mode=$(psql_q "select setting from pg_settings where name='archive_mode';")
  [ "${mode}" = "on" ] || die "archive_mode=${mode}：归档未开启，PITR 不成立"
}

do_wal() {
  assert_archive_on
  [ -d "${WAL_DIR}" ] || die "归档目录不存在：${WAL_DIR}（检查 .env 的 ERP_PG_ARCHIVE_HOST 与 compose 挂载）"

  local total bytes newest
  total=$(find "${WAL_DIR}" -type f | wc -l | tr -d ' ')
  bytes=$(du -sh "${WAL_DIR}" | awk '{print $1}')

  # 保留策略：删掉超过 N 天的归档段。基备保留 1 份（每周日+周三各一次 = 间隔 3.5 天），
  # 与 WAL 4 天窗口绑定；WAL 保留期必须 ≥ 基备间隔，否则最近基备失去前滚能力。
  # 2026-11-12：窗口由 7 天收紧到 4 天（本地 10G→约 7.6G，回收 2.4G）；基备频率由每周
  # 一次提到每周两次（cron 0,3），BASE_KEEP 维持 1。调用方如需维持 7 天，显式设 ERP_WAL_KEEP_DAYS=7。
  # 注意 find -mtime +N 是整日粒度、实际约 N+1 天，故 +4 实际保留约 5 天（偏保守，不丢数据）。
  find "${WAL_DIR}" -type f -mtime "+${WAL_KEEP_DAYS}" -delete 2>/dev/null || true
  local after kept
  after=$(find "${WAL_DIR}" -type f | wc -l | tr -d ' ')
  kept=$((total - after))
  [ "${kept}" -gt 0 ] && echo "保留 : 清理 ${kept} 段（超过 ${WAL_KEEP_DAYS} 天）"

  local stat failed archived
  stat=$(psql_q "select archived_count||'/'||failed_count||'/'||coalesce(last_archived_wal,'-') from pg_stat_archiver;")
  archived=${stat%%/*}
  failed=$(echo "${stat}" | cut -d/ -f2)

  # 取最新段用 `ls -1t | sed -n '1p'`，**不能**用 `| head -1`：在 `set -o pipefail`
  # 下，head 读一行即关闭管道，上游 ls 收到 SIGPIPE（141）让整个赋值返回非零，
  # set -e 随即**静默**退出——而所有 echo 都在这一行之后，于是日志一行不写。
  # 2026-11-04 实测：归档段累积到 407 个（路径约 18 KB，超过 macOS 管道缓冲区
  # 16 KB）后必然触发，表现是「脚本返回 1 但零输出」，极易被误判成「cron 没跑」。
  # sed -n '1p' 会读完整输入不提前退出，不会产生 SIGPIPE。
  newest=$(ls -1t "${WAL_DIR}" 2>/dev/null | sed -n '1p')
  [ -n "${newest}" ] && newest="${WAL_DIR}/${newest}"
  echo "归档 : 本机 ${after} 段 / ${bytes}"
  echo "归档器: 成功/失败/最近段 = ${stat}"
  [ -n "${newest}" ] && echo "最新 : $(basename "${newest}") @ $(stat -f '%Sm' -t '%F %T' "${newest}")"

  # 失败计数只增不减，非 0 说明至少有一次归档失败过：PG 会持续重试并堆 WAL，
  # 堆到磁盘满就是全库事故，必须让人看到。
  [ "${failed}" = "0" ] || { echo "✗ pg_stat_archiver 有 ${failed} 次失败，检查归档目录权限与磁盘" >&2; exit 1; }
  [ "${archived}" != "0" ] || { echo "✗ 从未归档成功过（archived_count=0）" >&2; exit 1; }
  echo "结论 : ✅ 归档正常"
}

do_base() {
  assert_archive_on
  mkdir -p "${BASE_DIR}"
  local ts out lsn
  ts=$(date +%Y%m%d_%H%M%S)
  out="${BASE_DIR}/base_${ts}"
  lsn=$(psql_q "select pg_current_wal_lsn();")

  echo "基备 : 起始 LSN ${lsn} → base_${ts}"
  # -Ft -z 出 tar.gz，-Xs 把回放所需 WAL 一并打进 pg_wal.tar.gz，-c fast 立刻 checkpoint。
  # 走 unix socket 而非 TCP：pg_hba 的 replication 规则只对 local/127.0.0.1 放行。
  if ! docker exec "${CONTAINER}" sh -c \
      "rm -rf /tmp/base_${ts} && mkdir -p /tmp/base_${ts} && \
       pg_basebackup -h /var/run/postgresql -U ${PGUSER} -D /tmp/base_${ts} \
         -Ft -z -Xs -c fast -l '${ts}'" 2>/tmp/pg_basebackup.err; then
    echo "✗ pg_basebackup 失败：" >&2
    tail -5 /tmp/pg_basebackup.err >&2
    exit 1
  fi
  mkdir -p "${out}"
  docker cp "${CONTAINER}:/tmp/base_${ts}/." "${out}/" >/dev/null
  docker exec "${CONTAINER}" rm -rf "/tmp/base_${ts}"

  # 逐包 gzip 完整性校验：能解压才算基备可用，不是「文件存在」就算。
  local f
  for f in "${out}"/*.tar.gz; do
    [ -f "${f}" ] || continue
    gzip -t "${f}" || { echo "✗ ${f} 压缩包损坏" >&2; exit 1; }
  done
  printf '%s\n' "backup_ts=${ts}" "start_lsn=${lsn}" "archive_mode=on" "wal_dir=${WAL_DIR}" > "${out}/manifest.txt"

  ls -1dt "${BASE_DIR}"/base_* 2>/dev/null | tail -n "+$((BASE_KEEP + 1))" | while read -r old; do
    rm -rf "${old}"
  done

  echo "基备 : $(du -sh "${out}" | awk '{print $1}')，文件 $(ls -1 "${out}" | tr '\n' ' ')"
  echo "保留 : 最新 ${BASE_KEEP} 份"
  echo "结论 : ✅ 物理基备完成"
}

case "${MODE}" in
  wal)  do_wal ;;
  base) do_base ;;
  *)    die "未知模式 ${MODE}（wal|base）" ;;
esac
