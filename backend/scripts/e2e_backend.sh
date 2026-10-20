#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."   # -> backend/
PY=/Users/aries/Applications/Python_3.13/bin/python3
# 独立 E2E env 文件注入 DATABASE_URL，绕过仓库根 .env 指向的生产库 heijin_erp_v1.db。
# 根因：pydantic-settings 在 Settings 类定义时调用 locate_env_file() 读取 env_file；
# 根目录 .env 里的 DATABASE_URL 会覆盖 export 的环境变量，使 uvicorn 误连生产库。
# 故用 ERP_ENV_FILE 指向仅含 E2E 库地址的临时文件，并以「命令前缀」方式注入
# （sandbox 下后台进程不继承 export 的环境变量，前缀语法直接绑定到子进程最稳）。
ENV_FILE="/tmp/heijin_e2e_env"
printf 'DATABASE_URL=sqlite:///./data/heijin_erp_e2e.db\n' > "$ENV_FILE"
# 默认 8124：8123 被用户常驻的「黑金时代生产 dev 后端」占用（连 heijin_erp_v1.db），
# E2E 必须独占一个端口以彻底隔离，绝不触碰生产库。可用 ERP_E2E_BACKEND_PORT 覆盖。
PORT="${ERP_E2E_BACKEND_PORT:-8124}"
echo "[e2e-backend] 重建 E2E 库（ERP_ENV_FILE=${ENV_FILE}）"
rm -f "data/heijin_erp_e2e.db"
echo "[e2e-backend] alembic upgrade head（建表 + foundation 种子）"
ERP_ENV_FILE="$ENV_FILE" "$PY" -m alembic upgrade head
echo "[e2e-backend] 创建/更新联调管理员 admin"
ERP_ENV_FILE="$ENV_FILE" ADMIN_PASSWORD="${ERP_E2E_ADMIN_PASSWORD:-12345678}" "$PY" scripts/create_admin.py
# 补齐 DEV 态 X-Dev-User 映射所需的 operator/finance/auditor/viewer 真实用户行（id 2..5），
# 与 app/core/security.py 的 DEV 用户映射一致，避免 PATCH /users/2 等接口 422。
echo "[e2e-backend] 补齐 DEV 映射用户（operator/finance/auditor/viewer）"
ERP_ENV_FILE="$ENV_FILE" "$PY" scripts/seed_e2e_users.py
# 批量验收订单夹具：创建 RECOVERY/PICKUP/CONSIGNMENT 等账户、订单与分期合同，
# 供 business-write 等真实写入联调用例使用。幂等（已有 [批量验收] 标记则跳过）。
# 该脚本自身未把 backend/ 加入 sys.path，故用 PYTHONPATH="$PWD" 注入（PWD 已 cd 到 backend/）。
echo "[e2e-backend] 批量验收订单夹具（账户/订单/合同）"
ERP_ENV_FILE="$ENV_FILE" PYTHONPATH="$PWD" "$PY" scripts/seed_batch_acceptance_orders.py
# 干净 IN_STOCK 账户夹具：验收种子会把 RECOVERY/PICKUP/CONSIGNMENT 账户通过事件消耗掉，
# 而部分 business-write 用例要求 IN_STOCK 且未消耗的账户，故单独补一组 pristine 账户（互不干扰）。
echo "[e2e-backend] 干净 IN_STOCK 账户夹具（RECOVERY/PICKUP/CONSIGNMENT 各一）"
ERP_ENV_FILE="$ENV_FILE" "$PY" scripts/seed_e2e_accounts.py
# 客户夹具：库存「售出」弹窗的「买家」下拉取自 /customers，空库会导致下拉无选项。
echo "[e2e-backend] 客户夹具（售出流程买家）"
ERP_ENV_FILE="$ENV_FILE" "$PY" scripts/seed_e2e_customers.py
# 诊断：把本实例将连接的库路径写到已知文件，供 E2E 跑后核验隔离是否生效（仅前台，不依赖后台 env）。
ERP_ENV_FILE="$ENV_FILE" "$PY" -c "from app.core.settings import get_settings; open('/tmp/e2e_db_path.txt','w').write(str(get_settings().sqlite_file))"
echo "[e2e-backend] 启动 uvicorn @ ${PORT}"
# 注意：本环境 bash 的 `exec VAR=val cmd` 赋值前缀是坏的（exec 会把 VAR=val 当成
# 要执行的文件路径）。故先 export 再 exec——脚本内同一进程 export，exec 子进程必继承。
export ERP_ENV_FILE="$ENV_FILE"
exec "$PY" -m uvicorn app.main:app --host 0.0.0.0 --port "$PORT"
