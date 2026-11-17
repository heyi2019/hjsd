# 宜游轩 ERP

FastAPI + React 的工作室经营系统。**v1 是唯一入口**（`app/main.py`）。

开发、测试和发布按以下三份流程执行：
[研发流程](docs/研发流程.md)

> 发布通道：远端只有 `origin/main`，`git push origin main` → `main-ci-cd` 自动升版 → dispatch lint / frontend / backend 三个门禁 → 全绿后 dispatch `deploy-production` → ECS 生产。**推送即上线**，纯文档提交同样会触发。

## 快速启动

```bash
# 0) 环境（一次性）
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements-dev.txt
cd frontend && npm install && cd ..

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

前端代理端口读取 `VITE_BACKEND_PORT`，开发环境固定为前端 `5188` → 后端 `8123`；本地 `main` worktree 使用前端 `5199` → 后端 `8125`。其他测试端口和验证方式见 [研发流程](docs/研发流程.md)。

登录页会先检查 `/api/v1/health`。后端未启动或端口不一致时，会直接提示连接问题，
不会再把 Vite 代理错误显示成笼统的 500。

启动后：

| 地址 | 用途 |
|---|---|
| http://127.0.0.1:8123/ | 服务信息（库路径、env 路径、版本） |
| http://127.0.0.1:8123/api/v1/health | 健康检查 |
| http://127.0.0.1:8123/docs | Swagger，全部 v1 端点 |
| http://127.0.0.1:5188/ | dev 前端（开发账号 `admin`） |

生产环境进入登录页，使用上一步创建的 `admin` 账号登录；开发环境仍保留角色直通，仅用于本地权限联调。

### 配置约定

- `.env` 查找顺序：`ERP_ENV_FILE` 覆盖 → 仓库根 `.env` → `backend/.env`。
  **根目录优先**，测试对此有断言（`tests/v1/test_settings.py`）。
- `DATABASE_URL` 必须是 v1 库。`core.settings` 硬拒绝 `heijin.db` / `heijin_v2.db`
  两个 v0 遗留库，防止误建。
- `*.db` 不入版本库，本地库由 `scripts/v1_init_db.py` 重建。

## 开发命令

```bash
# 后端测试
cd backend && .venv/bin/python -m pytest tests -q

# 迁移
cd backend && .venv/bin/python -m alembic upgrade head
cd backend && .venv/bin/python -m alembic check          # 应为「无新差异」

# 前端：守卫 + 类型 + 构建（build 自带前两步）
cd frontend && npm run check
cd frontend && npm run build
```

`npm run build` 会先跑 `scripts/ui_guards.mjs`：校验后端枚举状态值是否都被
`StatusTag` 覆盖、有无 `any`、可访问性等。新增后端状态枚举时守卫会先变红。

## 目录结构

| 目录 | 职责 |
|---|---|
| `backend/app/core` | settings / database / money / errors / security / audit / numbering |
| `backend/app/domain` | 当前 ORM 模型与领域对象 |
| `backend/app` 领域包 | 20 个已挂载 router：`foundation` `customer_center` `orders` + `orders.form_fields` `installments` `finance` `stocks` `reporting` `policy` `notifications` `imports` `audit` `auth` + `auth.admin`（人员）+ `auth.teams` `attachments` `options` `lists`；`core`/`domain` 为基础设施与 ORM，`shared` 为跨域共享原语（无独立 router） |
| `backend/alembic/squashed_versions` | **活动迁移链**：只有 `0001_current_schema_baseline`，head = `0001`（`alembic.ini` 的 `version_locations` 只指向此目录；改 ORM 即改基线，不再加增量迁移） |
| `backend/alembic/squashed_versions` | 唯一活动迁移基线 `0001`，用于全新 PostgreSQL 数据库初始化 |
| `tests/backend` | 后端测试（pytest，111 个文件） |
| `frontend/src` | 按业务域拆分（`orders/` `stocks/` `customers/` `installments/` `pools/` `rebates/` `reporting/` 等 20 个目录），无 `pages/`；`shared/` 为 UI 与 API 基础层 |
| `frontend/scripts/ui_guards.mjs` | UI 守卫 |
| `docs` | 当前有效文档：顶层事实源 / 工程文档 + `testing/` 测试体系；**全仓文档地图见 `docs/README.md`**；`archive/` 只保留 ux-audit 的 E2E 证据（JSON 与截图），历史文档已于 2026-11-11 全部清退 |
| `rawdata/原始数据` | 金山文档导出的 5 份只读 JSON |
| `data` `logs` `outputs` | 运行态与生成物，默认不提交 |

## 关键业务约束

写代码前必看 `docs/PRD.md` 与 `docs/数据字典.md`（旧功能规格 F01 已下线，编号体系见 `docs/testing/测试元数据台账.csv`（`FEATURE` 记录）），几条最容易踩的：

- **规则快照**（BAS-06-04）：订单 / 返点 / 分期创建时固化当时生效的规则版本与参数
  （`policy_version_id` + `policy_snapshot`）。改未来费率**不会**改写已发生业务的利润。
  已发布或已被引用的规则版本不可改，只能新建版本。
- **有效区间** `[effective_from, effective_to)` 左闭右开，`NULL` = 至今。
  同一定义下区间不得重叠——两个都无失效日的版本必然重叠，必须拒绝。
- **金额** 一律 `core.money.Amount`（DECIMAL(18,2)）+ `to_money()`，禁止 float 参与计算。
- **写路径** 一律走 Service 事务 + `core.audit.record_audit`，路由层不直接改模型。
- **权限** `require_permissions(...)` 返回的已是 `Depends` 对象，路由里**直接作默认值**，
  不要再包一层 `Depends()`。
- **校验错误** 抛 `Validation` 映射 **422**（非 400），断言要按项目惯例写。
