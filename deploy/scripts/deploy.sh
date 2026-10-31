#!/usr/bin/env bash
# 宜游轩 ERP 一键部署（在阿里云 ECS 上执行）
set -euo pipefail
cd "$(dirname "$0")/.."

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

if docker compose run --rm backend test -f /app/data/heijin_erp_v1.db; then
  echo "==> 迁移前备份正式库"
  docker compose run --rm backend \
    python /app/scripts/backup_db.py \
    --db /app/data/heijin_erp_v1.db \
    --out-dir /app/data/backups \
    --keep 30
else
  echo "==> 首次部署：正式库尚不存在，跳过备份"
fi

echo "==> 执行数据库迁移"
# 保留完整的 0001→0071 迁移链，兼容 ECS 现有 PostgreSQL 的 0064 版本戳；
# 不得在迁移失败时用 stamp_baseline.py 掩盖错误，否则会把结构未完成的库伪装成已升级。
docker compose run --rm backend alembic upgrade head

# 数据库版本「随推送版本来」：迁移完成后把当前发布版本戳记进 db_version 审计表，
# 可追溯「哪个发布版本动了库、落到哪个 schema 态」。版本优先级：脚本 --version >
# 容器环境 APP_VERSION > app/version.py 的 __version__（已随发版 bump）。
docker compose run --rm -e APP_VERSION backend python scripts/stamp_db_version.py

# 经营规则定义是系统闭集（REBATE / COMMISSION / INSTALLMENT / WRITE_DOWN / REFUND / DG_MIXED），
# 迁移只建表不预置，缺定义时 make_snapshot 返回空快照且不报错（静默失效）。
# 脚本幂等：定义按 (policy_code, GLOBAL) 判重、已有版本的跳过，可反复执行。
echo "==> 预置经营规则定义与默认版本（幂等）"
docker compose run --rm backend python scripts/seed_policy_definitions.py --apply

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

# 部署前备份与正式库同处 erp_db 卷，卷丢失会一起没；异地留存必须在另一台机器上做。
echo "==> 备份提醒（本次已做部署前快照，日常快照需另挂 cron）"
echo "  ECS: crontab -e → 20 3 * * * /bin/bash $(pwd)/scripts/backup_daily.sh"
echo "  本机: bash deploy/scripts/pull_backup.sh --host root@<ECS_IP>"
