# 宜游轩 ERP

FastAPI + React 的工作室经营系统。后端入口为 `app/main.py`。

开发与本地验收见 [研发流程](docs/研发流程.md)，测试见 [测试流程](docs/测试流程.md)，阿里云上线见 [发布流程](docs/发布流程.md)，版本规则与记录见 [版本管理](docs/版本管理.md)。

> 开发主线为 `origin/dev`，发布分支为 `origin/main`。更新 `main` 后由 `main-ci-cd` 同时启动 lint / frontend / backend 门禁与镜像构建，门禁全绿后才部署到 ECS。**更新 main 即触发生产发布**，纯文档提交同样会触发。

## 快速启动

```bash
# 0) 环境（一次性）
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements-dev.txt
npm install

# 1) 配置（一次性）—— .env 必须在**仓库根目录**
cp .env.example .env
#   生产环境务必替换 JWT_SECRET_KEY（≥32 位随机串）

# 2) 建库 + 种子（迁移到 head 并写入基础种子）
cd backend && .venv/bin/python scripts/v1_init_db.py && cd ..

# 2.1) 初始化正式管理员（首次部署必须执行；密码不会写入脚本）
cd backend && ADMIN_PASSWORD='请替换为强密码' .venv/bin/python scripts/create_admin.py && cd ..

# 3) 起后端（0.0.0.0:8123，局域网可访问）
cd backend && .venv/bin/python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8123

# 4) 起开发前端（:5188，新终端）
cd frontend && VITE_BACKEND_PORT=8123 npm run dev -- --host 0.0.0.0 --port 5188 --strictPort
```

前端代理端口读取 `VITE_BACKEND_PORT`，开发环境固定为前端 `5188` → 后端 `8123`。本地不保留 `main` worktree；测试和验证方式见 [研发流程](docs/研发流程.md)。

登录页会先检查 `/api/health`。后端未启动或端口不一致时，会直接提示连接问题，
不会再把 Vite 代理错误显示成笼统的 500。

启动后：

| 地址 | 用途 |
|---|---|
| http://127.0.0.1:8123/ | 服务信息（库路径、env 路径、版本） |
| http://127.0.0.1:8123/api/health | 健康检查 |
| http://127.0.0.1:8123/docs | Swagger，全部 API 端点 |
| http://127.0.0.1:5188/ | dev 前端（开发账号 `admin`） |

生产环境进入登录页，使用上一步创建的 `admin` 账号登录；开发环境仍保留角色直通，仅用于本地权限联调。

### 配置约定

- `.env` 查找顺序：`ERP_ENV_FILE` 覆盖 → 仓库根 `.env` → `backend/.env`。
- 本地开发使用 PostgreSQL 的 `heijin_erp_dev`；测试使用独立的 `heijin_erp_test`，运行前必须确认两者隔离。

## 开发命令

```bash
# 准备本机隔离测试环境（依赖和独立 Redis）
python3 backend/scripts/setup_test_environment.py
# 后端针对性测试（先确认测试库与开发库隔离）
scripts/ops/test-local.sh -q tests/backend/unit/system/test_settings.py

# 迁移
cd backend
PYTHONPATH=../dependencies/python313-runtime /Users/aries/Applications/Python_3.13/bin/python3 -m alembic upgrade head
PYTHONPATH=../dependencies/python313-runtime /Users/aries/Applications/Python_3.13/bin/python3 -m alembic check
cd ..

# 前端：守卫 + 类型 + 构建（build 自带前两步）
(cd frontend && npm run check)
(cd frontend && npm run build)
```

`npm run build` 会先跑 `scripts/ui_guards.mjs`：校验后端枚举状态值是否都被
`StatusTag` 覆盖、有无 `any`、可访问性等。新增后端状态枚举时守卫会先变红。

## 目录结构

| 目录 | 职责 |
|---|---|
| `backend/app/core` | settings / database / money / errors / security 等技术底座 |
| `backend/app/domain` | 当前 ORM 模型与领域对象 |
| `backend/app` 领域包 | `business`、`customers`、`funds`、`operations`、`settings`、`workbench`；`shared` 为跨域共享原语 |
| `backend/alembic/squashed_versions` | **活动迁移链**：只有 `0001_current_schema_baseline`，head = `0001`（`alembic.ini` 的 `version_locations` 只指向此目录；改 ORM 即改基线，不再加增量迁移） |
| `tests/backend` | 后端测试（pytest，按实际磁盘文件数维护） |
| `frontend/src` | 按业务域拆分，包含 `app`、`business`、`customer-center`、`finance`、`reporting`、`settings` 等；`shared` 为 UI 与 API 基础层 |
| `frontend/scripts/ui_guards.mjs` | UI 守卫 |
| `docs` | 当前有效文档：顶层事实源 / 工程文档 + `testing/` 测试体系；**全仓文档地图见 `docs/README.md`**；`archive/` 只保留 ux-audit 的 E2E 证据（JSON 与截图），历史文档已于 2026-11-11 全部清退 |
| `dependencies` | 本机 Python 依赖及前端依赖入口；不进入 Git 和 Docker 构建上下文 |
| `data` `logs` `outputs` | 运行态与生成物，默认不提交 |

## 关键业务约束

写代码前必看 `docs/PRD.md` 与 `docs/数据字典.md`（旧功能规格 F01 已下线，编号体系见 `docs/testing/测试元数据台账.csv`（`FEATURE` 记录）），几条最容易踩的：

- **分润比例**：公司盈利和亏损分润比例可在设置中调整，默认分别为 40% 和 50%；已有订单按当前设置和原人员占比计算。
- **金额** 一律 `core.money.Amount`（DECIMAL(18,2)）+ `to_money()`，禁止 float 参与计算。
- **写路径** 一律走 Service 事务 + `shared.audit.record_audit`，路由层不直接改模型。
- **权限** 使用 `settings.auth.session.require_permissions` 配合 FastAPI `Depends`。
- **校验错误** 抛 `Validation` 映射 **422**（非 400），断言要按项目惯例写。
