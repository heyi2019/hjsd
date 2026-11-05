# ERP 本地开发与联调指南 v1.1

## 版本记录

| 版本 | 日期 | 变更摘要 |
|---|---|---|
| v1.1 | 2026-11-01 | 后端绑定改 0.0.0.0；更正前端 dev 端口未在 vite.config 固定（默认 5173，可 --port 指定）；补代理端口优先级与 E2E 隔离说明；旧版 ERP_本地开发与联调指南_v1.0_已作废.md 归档于 `docs/archive/` |
| v1.2（同版修订） | 2026-11-02 | E2E（Playwright）体系整体下线，第 6 章改写为「验证分层 + 代价说明」；数据库统一 PostgreSQL，删去 SQLite 相关表述 |


> 本文是工程启动契约。业务规则以 [PRD](ERP_PRD_v1.3_当前实现版.md)、[ERP_PRD_F01_功能规格说明书](ERP_PRD_F01_功能规格说明书.md)、[数据字典](ERP_数据字典_v2.0.md) 为准；本文不覆盖业务口径。

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
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8123
```

如果未手动激活虚拟环境，启动时使用 `.venv/bin/python -m uvicorn ...`；不要使用系统 Python 直接执行后端脚本。

健康检查：`GET http://127.0.0.1:8123/`；接口文档：`http://127.0.0.1:8123/docs`。v1 新接口统一挂载 `/api/v1`；新增业务不得继续扩展旧路由。

### 前端

```bash
cd frontend
npm ci
npm run dev
```

浏览器访问 Vite 输出的地址。**前端 dev 端口未在 `vite.config.ts` 中固定**，`npm run dev`（即 `vite --host`）默认落在 5173，需要多项目并存时用 `npm run dev -- --port 5188` 之类显式指定；`host` 已设为 `0.0.0.0`，局域网可直接访问。前端请求统一走同源 `/api/v1`，由 Vite 代理到 `127.0.0.1:${VITE_BACKEND_PORT:-8123}`，不得散落硬编码 URL。

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

## 6. 端到端测试：已下线（2026-11-02）

Playwright E2E 体系已整体删除：`frontend/e2e/`（13 个 spec / 50 例 / 4 张视觉基线）、`frontend/playwright.config.ts`、`backend/scripts/e2e_backend.sh`、5 个 `seed_e2e_*` / `seed_batch_acceptance_orders` 夹具脚本，以及 CI 的 `frontend-e2e` job 与 `auto-merge` 里对应的 gate。

删除原因：E2E 需要独立的 SQLite 库（`heijin_erp_e2e.db`）与 Chromium，维护成本高，且与「运行时统一 PostgreSQL」不一致；同时 50 例里已有一批长期漂移的失败项。

**现在的验证分层**（替代 E2E 的位置）：

| 层 | 入口 | 耗时 | 能证明什么 |
|---|---|---|---|
| 单元 | `cd frontend && npm run test:fast` | 秒级 | 纯逻辑正确 |
| 模块 / 面板 | `npm run test:panel -- <域>` | 分钟级 | 组件渲染与交互逻辑（jsdom） |
| 后端接口 | `cd backend && python3 run_regression.py <域>` | 分钟级 | 契约、权限、状态机、真实 PG 语义 |

**代价必须说清**：不再有「真实浏览器点下去」的自动化验证。导航可达、外壳不白屏、关键写路径这三类问题，现在只能靠人工点一遍，或按需临时起服务用 `cd frontend && npm run audit:ux` 巡检（脚本 `frontend/scripts/ux-audit.mjs`，7 页 × 3 视口，覆盖 CLS / WCAG 对比度 / 触控目标 / 横向溢出 / 500 可见性，产出 `/tmp/ux-audit/result.json` 与截图；直接用 `playwright` 包做浏览器体检，不属于测试框架，故脚本保留）。巡检前须先起前端，默认打 `http://localhost:5180/`，用 `UXP_BASE` 指向别的实例（如 `UXP_BASE=http://localhost:5188/`）。

如需找回：`git log --diff-filter=D -- frontend/e2e` 可定位删除前的完整快照。
