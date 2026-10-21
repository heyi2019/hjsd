# ERP 本地开发与联调指南 v1.0

> 本文是工程启动契约。业务规则以 [PRD](ERP_PRD_v1.2_当前实现版.md)、[ERP_PRD_F01_功能规格说明书](ERP_PRD_F01_功能规格说明书.md)、[数据字典](ERP_数据字典_v1.0.md) 为准；本文不覆盖业务口径。

## 1. 前置条件

| 工具 | 建议版本 | 用途 |
|---|---:|---|
| Python | 3.11+ | FastAPI、迁移与测试 |
| Node.js | 20 LTS+ | React / Vite |
| npm | 10+ | 前端依赖与构建 |
| SQLite | 3.35+ | 本地 MVP 数据库 |
| PostgreSQL | 16+（可选） | 正式环境 |

首次克隆后，复制根目录 `.env.example` 为 `.env`，替换 `JWT_SECRET_KEY` 与数据库连接。`.env` 不得提交。后端必须在 `core/settings` 读取该文件。

## 2. 启动步骤

### 后端

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8123
```

如果未手动激活虚拟环境，启动时使用 `.venv/bin/python -m uvicorn ...`；不要使用系统 Python 直接执行后端脚本。

健康检查：`GET http://127.0.0.1:8123/`；接口文档：`http://127.0.0.1:8123/docs`。v1 新接口统一挂载 `/api/v1`；新增业务不得继续扩展旧路由。

### 前端

```bash
cd frontend
npm ci
npm run dev
```

浏览器访问 Vite 输出的地址（默认 `http://localhost:5173`）。前端请求基址只从 `VITE_API_BASE` 读取，不得散落硬编码 URL；本地默认后端端口为 `8123`。

### 测试与构建

```bash
cd backend && .venv/bin/python -m pytest
cd frontend && npm run check && npm run build
```

每个 P0 功能至少有：领域单测、API 测试、页面验收。基础回归数据使用 `tests/fixtures/v1_acceptance_seed.json`；测试只能使用临时数据库，禁止连接开发或生产库。

## 3. 联调顺序

1. 实现迁移与种子：主数据、客户、合作方、业务路由。
2. 按 API 文档实现认证/权限、订单创建与参与方校验。
3. 依次实现事件→现金流、账号成本、两类分期、返点、押金。
4. 用 A01–A11 跑后端回归，再接页面的列表、详情、动作抽屉。
5. 最后接报表、质量工作台及 P1 功能。

联调期间以 `order_no`、`event_no`、`flow_no`、`customer_no`、`counterparty_no` 作为对象追踪键；不使用姓名、手机号或微信号做关联键。

## 4. 数据与迁移纪律

- 新业务库与旧 `heijin.db` 分离；导入是 P2，只能写参考记录。
- 金额全程 `Decimal` / `DECIMAL(18,2)`，禁止 float。
- 任何写入必须走 Service 事务，写审计，并在失败时整体回滚。
- 禁止手工修改余额、补造划转另一边或自动匹配历史关系。
- 本地数据库、日志、导出物与真实客户联系方式均不得提交 Git。

## 5. 提交前最小检查

- `pytest`、`npm run check`、`npm run build` 通过。
- 变更关联至少一个功能编号，例如 `CUS-01-02`。
- 涉及接口时更新 API 文档、错误码/状态机和对应测试。
- 涉及表结构时新增 Alembic revision，更新数据字典和 DDL；不得手改生产 schema。

## 6. E2E 端到端测试（Playwright）

前端 E2E 采用 Playwright + Chromium，配置见 `frontend/playwright.config.ts`，用例在 `frontend/e2e/*.spec.ts`。开发态（`import.meta.env.DEV`）零登录直进 `AppShell`，E2E 全部在 dev server 下运行，无需真实 token。

### 运行方式

```bash
cd frontend
./node_modules/.bin/playwright test                 # 全量
./node_modules/.bin/playwright test e2e/smoke.spec.ts   # 单文件
```

`playwright.config.ts` 的 `webServer` 会自动拉起两个服务，无需手工启后端：

| 服务 | 端口 | 说明 |
|---|---:|---|
| 前端 dev server | 5180 | `vite --strictPort`；若已占用则复用 |
| E2E 后端 | 8124 | `backend/scripts/e2e_backend.sh` 每次重建**独立库 `heijin_erp_e2e.db`** |

**端口隔离是硬约束**：8123 为你常驻的「生产 dev 后端」（连 `heijin_erp_v1.db`），E2E 严禁复用它的库，故固定走 8124。可用 `ERP_E2E_BACKEND_PORT` / `ERP_E2E_API_BASE` 覆盖。

### 浏览器

Playwright 1.64.0 + Chromium。若报 `Executable doesn't exist`，执行 `./node_modules/.bin/playwright install chromium`；本机浏览器缓存可能不在默认 `~/.cache/ms-playwright`，以 `PLAYWRIGHT_BROWSERS_PATH` 为准。

### 当前基线（2026-10-21 实测）

- 全量 **50 / 50 通过，约 1.2 分钟**（10 个 spec：smoke / auth-login / business-write / crud / integration / other-integration / role-switch / fallback / upgrade-integration / visual）。
- 串行执行（`workers:1`、`fullyParallel:false`），antd 下拉与真实浏览器状态并行易互相干扰。

### 视觉快照策略

`visual.spec.ts` 对工作台、登录页做像素基线比对。**有意的 UI 改动**（配色令牌、间距）会使快照过期，此时：

1. 先看 `test-results/**/…-diff.png`，确认差异仅限本次改动区域（避免把回归当基线批准）；
2. 再 `./node_modules/.bin/playwright test e2e/visual.spec.ts --update-snapshots` 重生成；
3. 复跑全量确认 50/50 绿，并把快照随改动一并提交。

### 提交前

E2E 与单测分开：单测（`vitest`）测逻辑，E2E 守主干（导航可达、外壳不白屏、关键写路径）。二者都要绿才算通过。
