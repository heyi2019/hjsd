# ERP 本地开发与联调指南 v1.0

> 本文是工程启动契约。业务规则以 [PRD](ERP_PRD_v1.0.md)、[功能规格](ERP_功能规格说明书_v1.0.md)、[数据字典](ERP_数据字典_v1.0.md) 为准；本文不覆盖业务口径。

## 1. 前置条件

| 工具 | 建议版本 | 用途 |
|---|---:|---|
| Python | 3.11+ | FastAPI、迁移与测试 |
| Node.js | 20 LTS+ | React / Vite |
| npm | 10+ | 前端依赖与构建 |
| SQLite | 3.35+ | 本地 MVP 数据库 |
| PostgreSQL | 16+（可选） | 正式环境 |

首次克隆后，复制根目录 `.env.example` 为 `.env`，替换 `JWT_SECRET_KEY` 与数据库连接。`.env` 不得提交。v1 后端必须在 `core/settings` 读取该文件；尚未完成改造的 legacy 入口不可把示例环境变量误认为已生效。

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

- 新业务库与旧 `heijin.db` 分离；历史导入是 P2，只能写参考记录。
- 金额全程 `Decimal` / `DECIMAL(18,2)`，禁止 float。
- 任何写入必须走 Service 事务，写审计，并在失败时整体回滚。
- 禁止手工修改余额、补造划转另一边或自动匹配历史关系。
- 本地数据库、日志、导出物与真实客户联系方式均不得提交 Git。

## 5. 提交前最小检查

- `pytest`、`npm run check`、`npm run build` 通过。
- 变更关联至少一个功能编号，例如 `CUS-01-02`。
- 涉及接口时更新 API 文档、错误码/状态机和对应测试。
- 涉及表结构时新增 Alembic revision，更新数据字典和 DDL；不得手改生产 schema。
