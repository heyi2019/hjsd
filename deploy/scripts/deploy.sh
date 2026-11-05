#!/usr/bin/env bash
# 宜游轩 ERP 一键部署（在阿里云 ECS 上执行）
set -euo pipefail
cd "$(dirname "$0")/.."

# CI/回滚可显式传入版本；先暂存，避免下面加载 ECS .env 时被遗留的
# APP_VERSION 覆盖。未显式传入时，版本仍只从 backend/app/version.py 解析。
requested_app_version="${APP_VERSION:-}"

if [ ! -f .env ]; then
  echo "✗ 缺少 deploy/.env"
  echo "  请先执行： cp env/.env.production.example .env"
  echo "  并填入 JWT_SECRET_KEY（openssl rand -hex 32）与 CORS_ORIGINS"
  exit 1
fi

# 让管理员初始化与 docker compose 使用同一份部署配置；.env 由运维维护且不入库。
set -a
. ./.env
set +a

if [ -n "$requested_app_version" ]; then
  APP_VERSION="$requested_app_version"
else
  unset APP_VERSION || true
fi

# 版本号唯一事实源是 backend/app/version.py：这里解析后导出，供镜像 tag 与容器内 /health 使用。
# 不从 .env 读，避免"改了代码忘改配置"导致线上显示旧版本。
# 解析失败只降级为 latest 并告警——版本标识不该成为部署关键路径上的阻断点。
# 部署/回滚可显式覆盖版本（回滚时由 CI 传入 APP_VERSION=旧版本）；
# 正常发布不设置该变量，仍从 version.py 单一事实源解析。
if [ -z "${APP_VERSION:-}" ]; then
  APP_VERSION="$(sed -n 's/^__version__ = "\(.*\)"$/\1/p' ../backend/app/version.py 2>/dev/null | head -1 || true)"
fi
if [ -z "$APP_VERSION" ]; then
  APP_VERSION="latest"
  echo "⚠ 未能从 ../backend/app/version.py 解析版本号，镜像 tag 回落 latest" >&2
fi
export APP_VERSION
echo "==> 发布版本 V${APP_VERSION}（镜像 tag 同此值）"

# 离线路径：ERP_SKIP_BUILD=1 表示镜像已由 docker load 导入，不走构建。
# 价值在于彻底切断「ECS 必须能访问 Docker Hub / alpine 源 / pypi / npm」这条链——
# 镜像在联网机器上构建完毕，ECS 只做 load，四个网络依赖全部归零。
if [ "${ERP_SKIP_BUILD:-0}" = "1" ]; then
  echo "==> 离线模式：跳过构建，校验已导入镜像"
  for svc in backend frontend; do
    img="heijin-${svc}:${APP_VERSION}"
    if ! docker image inspect "$img" >/dev/null 2>&1; then
      echo "✗ 缺少镜像 ${img}" >&2
      echo "  请先导入离线包：gunzip -c heijin-images-${APP_VERSION}-amd64.tar.gz | docker load" >&2
      exit 1
    fi
    # 架构必须逐字节对上：arm64 镜像在 x86_64 上会 exec format error，
    # 而 compose 的启动报错只显示 exit 1，很难联想到架构。
    arch="$(docker image inspect "$img" --format '{{.Architecture}}')"
    if [ "$arch" != "amd64" ]; then
      echo "✗ ${img} 架构为 ${arch}，本机需要 amd64" >&2
      echo "  请在联网的 x86_64 机器上构建，或用 buildx --platform linux/amd64 交叉构建后导出" >&2
      exit 1
    fi
    echo "  ✓ ${img} (${arch})"
  done
else
# 基础镜像预检：Docker Hub 在部分网络（尤其 ECS 国内节点）不可达，而失败点落在 Dockerfile
# 的 FROM 行、报错形似代码问题（TLS handshake timeout）。这里提前拉取，把网络问题变成明示。
echo "==> 检查基础镜像"
for img in alpine:3.20 node:22-alpine; do
  if docker image inspect "$img" >/dev/null 2>&1; then
    echo "  ✓ ${img} 已存在"
    continue
  fi
  echo "  拉取 ${img} ..."
  if docker pull "$img" >/dev/null; then
    echo "  ✓ ${img} 已拉取"
    continue
  fi
  cat >&2 <<EOF
✗ 无法拉取 ${img}，构建会在 Dockerfile 的 FROM 行失败。
  这是 ECS 最常见的阻塞项（TLS handshake timeout / connection reset），不是镜像或代码问题。

  解决方式（任选其一）：
    1) 配镜像加速器：
         sudo mkdir -p /etc/docker
         echo '{"registry-mirrors":["https://<你的ID>.mirror.aliyuncs.com"]}' | sudo tee /etc/docker/daemon.json
         sudo systemctl daemon-reload && sudo systemctl restart docker
       （加速地址在阿里云「容器镜像服务 → 镜像工具 → 镜像加速器」页面获取）
    2) 从能联网的机器导出后上传：
         docker save ${img} | gzip > ${img//[:.]/_}.tar.gz
         scp <文件> root@<ECS_IP>:/tmp/ && ssh root@<ECS_IP> 'gunzip -c /tmp/xx.tar.gz | docker load'
       注意：必须是 linux/amd64 镜像。Apple Silicon 等 arm64 机器构建的镜像不能用于 ECS。
EOF
  exit 1
done

echo "==> 构建镜像"
docker compose build
fi

# 迁移前必须有一份可信的库快照：迁移改的是结构，出错往往不可逆。
# 备份逻辑只有一处真相（backup_daily.sh，pg_dump -Fc + sha256 + 完整性闸门），
# 这里只负责「先把 db 拉起来 → 备份 → 备份失败就中止发布」。
echo "==> 确保 db 服务就绪（迁移前备份依赖它）"
docker compose up -d db

db_ready=0
for _ in $(seq 1 20); do
  if docker compose exec -T db sh -c 'pg_isready -U "$POSTGRES_USER" -q' </dev/null >/dev/null 2>&1; then
    db_ready=1; break
  fi
  sleep 2
done
if [ "$db_ready" -ne 1 ]; then
  echo "✗ db 在 40s 内未就绪，已中止发布（不在没有备份的情况下改结构）" >&2
  exit 1
fi

echo "==> 预检：数据库版本戳能否被活动迁移链解析"
# 活动链已压平为单一 0001，历史增量迁移（0065~0071 等）不再加载。
# 生产库若停在旧链（如 0064_expand_buy_rebate_scope），alembic 会在执行任何 DDL 之前
# 报 Can't locate revision 并中止。这里提前拦一次，把「不要 stamp 绕过」的指引打到日志里，
# 避免运维现场把结构落后的库 stamp 成已升级（那样之后 upgrade head 是空操作）。
migration_probe="$(docker compose run --rm --no-deps backend alembic current </dev/null 2>&1 || true)"
if printf '%s\n' "$migration_probe" | grep -q "Can't locate revision"; then
  printf '%s\n' "$migration_probe" | sed 's/^/    /' >&2
  cat >&2 <<'MIGRATION_CHAIN_MSG'

✗ 数据库版本戳不在活动迁移链内，升级必然失败，已中止（未做任何改动）。
  活动链已压平为单一 0001，0065~0071 等历史增量已不存在。
  ⚠ 不要用 alembic stamp 绕过：对结构落后的库 stamp 之后 upgrade head 是空操作，
    等于把未完成的库伪装成已升级。
  正确路径：备份数据 → 空库 alembic upgrade head 建全量结构 → 清洗后导入 → 校验。
  详见 docs/ERP_数据库架构检查与治理方案_V1.1_20261103.md 第五节。
MIGRATION_CHAIN_MSG
  exit 1
fi
printf '%s\n' "$migration_probe" | sed 's/^/    /'

echo "==> 迁移前备份 PostgreSQL 正式库"
if ! bash scripts/backup_daily.sh; then
  echo "✗ 迁移前备份失败，已中止发布（不在没有备份的情况下改结构）" >&2
  exit 1
fi

# 发布不变量基线：只采集，不写库。用升级前后逐项比对自动证明发布通道没有偷改库结构
# 或业务数据（历史上 stamp_db_version / seed_policy_definitions 会破坏这一口径）。
# 用户与库名与 compose 的 db 服务同源；宿主未 export 时按 compose 默认值回落。
db_snapshot() {
  docker compose exec -T db psql \
    -U "${POSTGRES_USER:-erp_app}" -d "${POSTGRES_DB:-heijin_erp}" -tAc \
    "select
       (select count(*) from information_schema.tables where table_schema=current_schema()),
       coalesce((select to_regclass('public.db_version')::text), 'NONE'),
       (select count(*) from policy_definitions),
       (select count(*) from option_sets),
       (select count(*) from order_form_fields where order_type_code='SALE'),
       (select count(*) from order_form_fields),
       (select version_num from alembic_version)"
}

# psql 返回异常（连接失败 / 列数不符 / 空值）时立即中止，不能让下面的算术比较
# 退化成 "[: : integer expression expected" 这种无法定位的报错。
validate_state() {
  local label="$1" state="$2" tables _dbver policies options sale fields _alembic
  IFS='|' read -r tables _dbver policies options sale fields _alembic <<< "$state"
  if ! [[ "$tables" =~ ^[0-9]+$ && "$policies" =~ ^[0-9]+$ && "$options" =~ ^[0-9]+$ \
          && "$sale" =~ ^[0-9]+$ && "$fields" =~ ^[0-9]+$ ]]; then
    printf '✗ %s库状态采集格式异常，已中止发布：%q\n' "$label" "$state" >&2
    exit 1
  fi
}

echo "==> 采集发布前库状态基线（只读）"
pre_state="$(db_snapshot)"
validate_state "发布前" "$pre_state"
IFS='|' read -r pre_tables pre_dbversion pre_policies pre_optionsets pre_sale_rows pre_fields pre_alembic <<< "$pre_state"
echo "  ${pre_state}"

echo "==> 执行数据库迁移"
# 活动链已压平为单一 0001（alembic.ini 的 version_locations 只指 squashed_versions），
# ECS 现存的 0064 版本戳无法解析，会在此处硬停——这是预期行为，不是 bug。
# 首次上线必须先按 Release→Prod 流程重建库；不得用 stamp 把结构未完成的库伪装成已升级。
docker compose run --rm backend alembic upgrade head

# 发布纪律（V1.0.4 起）：部署脚本不得改库结构、不得写业务数据。
# 下面两个历史调用已移除，禁止再加回：
#   - scripts/stamp_db_version.py        → create_all 自建 db_version 表（41 → 42 表）
#   - scripts/seed_policy_definitions.py → 写入 policy_definitions 定义与默认版本（0 → 6）
# 活动迁移链已压平为 0001，结构升级只由 Alembic / 上线执行单负责；经营规则由业务侧按
# 裁决预置，部署时静默写入会让「升级前后库状态一致」的验收口径失效。
# 脚本文件保留在镜像内，确需执行时由运维显式手工调用，不进自动发布通道。
echo "==> 跳过历史版本戳与规则预置（发布通道不写库结构与业务数据）"

echo "==> 启动服务"
if ! docker compose up -d; then
  # Docker Compose 在重建依赖服务的瞬间可能返回旧容器 ID 不存在；
  # 等待一次让 Docker 完成清理后重试，真实启动错误仍会在第二次失败时退出。
  echo "⚠ 首次启动返回错误，等待 Docker 清理依赖容器后重试"
  sleep 5
  docker compose up -d
fi

if [ -n "${ADMIN_PASSWORD:-}" ]; then
  echo "==> 初始化管理员账号"
  docker compose exec -T -e ADMIN_PASSWORD="$ADMIN_PASSWORD" backend \
    python scripts/create_admin.py
else
  echo "⚠ 未设置 ADMIN_PASSWORD，服务已启动但尚未初始化管理员账号"
  echo "  首次部署前请执行：export ADMIN_PASSWORD='至少 8 位强密码'"
  echo "  然后重新运行 ./scripts/deploy.sh"
fi

echo "==> 服务状态"
docker compose ps

echo "==> 后端健康检查"
health_response=""
health_ok=0
for attempt in {1..30}; do
  if health_response="$(curl -fsS --max-time 5 http://127.0.0.1/api/v1/health 2>/dev/null)"; then
    printf '%s\n' "$health_response"
    echo "  OK（第 ${attempt} 次检查）"
    health_ok=1
    break
  fi
  sleep 2
done

if [ "$health_ok" -ne 1 ]; then
  echo "  ✗ 健康检查在 60 秒内未通过，请查 docker compose logs backend frontend" >&2
  docker compose logs --tail=80 backend frontend >&2 || true
  exit 1
fi

# 已有库升级必须补齐表单作用域：0001 在生产已 stamp，create_all + seed_catalog 不会重播
# 种子，漏跑会让回收/提号/代挂三张售出表单回落硬编码默认值、丢失管理员既有配置。
# 脚本随 backend 镜像落在 /app/scripts/，旧镜像（回滚场景）没有该文件则跳过，不阻断回滚。
echo "==> 补齐售出表单三作用域（幂等；旧镜像无脚本则跳过）"
b4_applied=0
if docker compose exec -T backend sh -c 'test -f scripts/split_sale_form_scopes.py'; then
  docker compose exec -T backend python3 scripts/split_sale_form_scopes.py
  b4_applied=1
else
  echo "  ⚠ 本版镜像未内置补齐脚本，跳过（回滚到旧版本时属正常）"
fi

echo "==> 发布后不变量校验（只读）"
post_state="$(db_snapshot)"
validate_state "发布后" "$post_state"
IFS='|' read -r post_tables post_dbversion post_policies post_optionsets post_sale_rows post_fields post_alembic <<< "$post_state"
echo "  ${post_state}"

invariant_fail=0
assert_unchanged() {
  local label="$1" before="$2" after="$3"
  if [ "$before" = "$after" ]; then
    printf '  ✓ %s: %s\n' "$label" "$after"
  else
    printf '  ✗ %s 发生变化：%s → %s\n' "$label" "$before" "$after" >&2
    invariant_fail=1
  fi
}

assert_unchanged "表数" "$pre_tables" "$post_tables"
assert_unchanged "db_version 表" "$pre_dbversion" "$post_dbversion"
assert_unchanged "policy_definitions 行数" "$pre_policies" "$post_policies"
assert_unchanged "option_sets 行数" "$pre_optionsets" "$post_optionsets"
assert_unchanged "历史 SALE 行数" "$pre_sale_rows" "$post_sale_rows"
assert_unchanged "alembic 版本戳" "$pre_alembic" "$post_alembic"

if [ "$post_fields" -lt "$pre_fields" ]; then
  echo "  ✗ 字段总数倒退：${pre_fields} → ${post_fields}" >&2
  invariant_fail=1
else
  echo "  ✓ 字段总数：${pre_fields} → ${post_fields}（只增不减）"
fi

if [ "$b4_applied" = "1" ]; then
  scope_state="$(docker compose exec -T db psql \
    -U "${POSTGRES_USER:-erp_app}" -d "${POSTGRES_DB:-heijin_erp}" -tAc \
    "select
       (select count(*) from order_form_fields where order_type_code='SALEREC'),
       (select count(*) from order_form_fields where order_type_code='SALETH'),
       (select count(*) from order_form_fields where order_type_code='SALEDG')")"
  IFS='|' read -r rec_fields th_fields dg_fields <<< "$scope_state"
  if ! [[ "$rec_fields" =~ ^[0-9]+$ && "$th_fields" =~ ^[0-9]+$ && "$dg_fields" =~ ^[0-9]+$ ]]; then
    printf '  ✗ 售出三作用域计数格式异常：%q\n' "$scope_state" >&2
    exit 1
  fi
  if [ "$rec_fields" -gt 0 ] && [ "$th_fields" -gt 0 ] && [ "$dg_fields" -gt 0 ]; then
    echo "  ✓ 售出三作用域：SALEREC=${rec_fields} SALETH=${th_fields} SALEDG=${dg_fields}"
  else
    echo "  ✗ 售出三作用域存在空字段集：SALEREC=${rec_fields} SALETH=${th_fields} SALEDG=${dg_fields}" >&2
    invariant_fail=1
  fi
fi

if [ "$invariant_fail" -ne 0 ]; then
  echo "✗ 发布后不变量校验失败，请按上线执行单回滚段处置" >&2
  exit 1
fi

# 部署前备份与正式库同处 erp_db 卷，卷丢失会一起没；异地留存必须在另一台机器上做。
echo "==> 备份提醒（本次已做部署前快照，日常快照需另挂 cron）"
echo "  ECS: crontab -e → 20 3 * * * /bin/bash $(pwd)/scripts/backup_daily.sh"
echo "  本机: bash deploy/scripts/pull_backup.sh --host root@<ECS_IP>"
