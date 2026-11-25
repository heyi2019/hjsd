# 宜游轩 ERP

FastAPI + React 的工作室经营系统。后端入口为 `app/main.py`。

开发与本地验收见 [研发流程](docs/研发流程.md)，测试见 [测试流程](docs/测试流程.md)，阿里云上线见 [发布流程](docs/发布流程.md)，版本规则与记录见 [版本管理](docs/版本管理.md)。

> 开发主线为 `origin/dev`。GitHub 发布将已确认的 `dev` 内容合并进 `main`，`main-ci-cd` 的三道门禁通过后构建镜像并部署到 ECS。更新 `main` 会触发该流程，包括纯文档提交。本地 CI/CD 发布直接使用 `origin/dev` 当前提交，经本地完整检查后部署。

## 快速启动

```bash
# 0) 环境（一次性）
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements-dev.lock.txt
npm install

# 1) 配置（一次性）—— .env 必须在**仓库根目录**
cp .env.example .env
#   生产环境务必替换 JWT_SECRET_KEY（≥32 位随机串）
#   前端本机配置：已有文件时保留原配置
[ -e frontend/.env.local ] || cp frontend/.env.example frontend/.env.local

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

- 后端 `.env` 查找顺序：`ERP_ENV_FILE` 覆盖 → 仓库根 `.env` → `backend/.env`。
- 从 `frontend` 目录启动 Vite 时，前端环境文件放在 `frontend` 目录；本机可由 `frontend/.env.example` 创建 `frontend/.env.local`。启动命令中显式设置的环境变量优先。
- `VITE_API_BASE` 控制前端请求地址，开发环境推荐 `/api`；`VITE_BACKEND_PORT` 控制 Vite 代理的后端端口。根目录 `.env` 中的同名 `VITE_API_BASE` 不会被上述前端启动方式自动读取；前端镜像构建时由 Dockerfile 设置为 `/api`。
- 根目录 `.env` 与 `frontend/.env.local` 是本机配置，均不提交到 Git；`.env.example` 是可提交的配置模板。
- 本地开发使用 PostgreSQL 的 `heijin_erp_dev`；测试使用独立的 `heijin_erp_test`，运行前必须确认两者隔离。

## 开发命令

```bash
# 准备本机隔离测试环境（依赖和独立 Redis）
python3 backend/scripts/setup_test_environment.py
# 修改后端依赖声明后，在仓库根目录重新生成对应锁文件
# backend/.venv/bin/pip-compile --no-emit-index-url --output-file=backend/requirements.lock.txt --strip-extras backend/requirements.txt
# backend/.venv/bin/pip-compile --no-emit-index-url --allow-unsafe --constraint backend/requirements.lock.txt --output-file=backend/requirements-dev.lock.txt --strip-extras backend/requirements-dev.txt
# 后端针对性测试（先确认测试库与开发库隔离）
scripts/ops/test-local.sh -q tests/backend/unit/system/test_settings.py

# 迁移
cd backend
PYTHONPATH=../dependencies/python313-runtime /Users/aries/Applications/Python_3.13/bin/python3 -m alembic upgrade head
PYTHONPATH=../dependencies/python313-runtime /Users/aries/Applications/Python_3.13/bin/python3 -m scripts.ensure_idempotency_records --apply
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
| `backend/app` 领域包 | `business`、`customers`、`finance`、`operations`、`settings`、`workbench`；`shared` 为跨域共享原语 |
| `backend/alembic/squashed_versions` | **活动迁移链**：`0001_current_schema_baseline` 和 `0002_dictionary_codes`，head = `0002`；新库与既有库均通过 `alembic upgrade head` 按版本升级 |
| `tests/backend` | 后端测试（pytest，按实际磁盘文件数维护） |
| `frontend/src` | 按业务域拆分，包含 `workbench`、`business`、`customers`、`finance`、`operations`、`settings`；`app` 为应用外壳，`shared` 为 UI 与 API 基础层 |
| `frontend/scripts/ui_guards.mjs` | UI 守卫 |
| `docs` | 项目文档和 `testing/` 测试资料。`archive/` 集中保存历史文档和审查、测试、UX 证据。全仓文档地图见[文档目录](docs/README.md) |
| `dependencies` | 本机 Python 依赖及前端依赖入口；不进入 Git 和 Docker 构建上下文 |
| `runtime/logs`、`runtime/outputs` | 本机运行日志和通用临时产物。临时产物目录目前只有占位文件 |
| `outputs/local-release` | 本地发布通道生成的镜像压缩包、部署包和校验清单。发布包由本机保存，不提交到 Git |

## 关键业务约束

写代码前必看 `docs/PRD.md` 与 `docs/数据字典.md`（旧功能规格 F01 已下线，编号体系见 `docs/testing/测试元数据台账.csv`（`FEATURE` 记录）），几条最容易踩的：

- **分润比例**：公司盈利和亏损分润比例可在设置中调整，默认分别为 40% 和 50%；已有订单按当前设置和原人员占比计算。
- **金额** 一律 `core.money.Amount`（DECIMAL(18,2)）+ `to_money()`，禁止 float 参与计算。
- **写路径** 一律走 Service 事务 + `shared.audit.record_audit`，路由层不直接改模型。
- **权限** 使用 `settings.auth.session.require_permissions` 配合 FastAPI `Depends`。
- **校验错误** 抛 `Validation` 映射 **422**（非 400），断言要按项目惯例写。
