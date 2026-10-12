# 黑金时代 ERP

FastAPI + React 的工作室经营系统。**v1 是唯一入口**（`app/main.py`），旧版后端已归档在 `archive/v0_backend/`，不参与运行与测试。

## 快速启动

```bash
# 0) 环境（一次性）
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt
cd frontend && npm install && cd ..

# 1) 配置（一次性）—— .env 必须在**仓库根目录**
cp .env.example .env
#   生产环境务必替换 JWT_SECRET_KEY（≥32 位随机串）

# 2) 建库 + 种子（迁移到 head 并写入基础种子）
cd backend && python3 scripts/v1_init_db.py && cd ..

# 2.1) 初始化正式管理员（首次部署必须执行；密码不会写入脚本）
cd backend && ADMIN_PASSWORD='请替换为强密码' python3 scripts/create_admin.py && cd ..

# 3) 起后端（:8000）
cd backend && python3 -m uvicorn app.main:app --reload

# 4) 起前端（:5173，新终端）
cd frontend && npm run dev
```

启动后：

| 地址 | 用途 |
|---|---|
| http://127.0.0.1:8000/ | 服务信息（库路径、env 路径、版本） |
| http://127.0.0.1:8000/api/v1/health | 健康检查（返回 sqlite 是否已建） |
| http://127.0.0.1:8000/docs | Swagger，全部 89 个端点 |
| http://127.0.0.1:5173/ | 前端（开发账号 `admin`） |

生产环境进入登录页，使用上一步创建的 `admin` 账号登录；开发环境仍保留角色直通，仅用于本地权限联调。

### 配置约定

- `.env` 查找顺序：`ERP_ENV_FILE` 覆盖 → 仓库根 `.env` → `backend/.env`。
  **根目录优先**，测试对此有断言（`tests/v1/test_settings.py`）。
- `DATABASE_URL` 必须是 v1 库。`core.settings` 硬拒绝 `heijin.db` / `heijin_v2.db`
  两个 v0 遗留库，防止误建。
- `*.db` 不入版本库，本地库由 `scripts/v1_init_db.py` 重建。

## 开发命令

```bash
# 后端测试（220 条）
cd backend && python3 -m pytest tests -q

# 迁移
cd backend && python3 -m alembic upgrade head
cd backend && python3 -m alembic check          # 应为「无新差异」

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
| `backend/app/domain` | ORM 模型（**不叫 models**，与 legacy 命名冲突） |
| `backend/app/foundation` `finance` `orders` `installments` `policy` `quality` `reporting` | 领域服务与路由，每个含 `service.py` + `router.py` |
| `backend/alembic/versions` | 迁移（0001 M0 … 0005 M5 规则快照、0006 用户认证、0007 团队范围） |
| `backend/tests/v1` | v1 测试 |
| `frontend/src` | `shared/`（UI 与 API）、各领域页面目录 |
| `frontend/scripts/ui_guards.mjs` | UI 守卫 |
| `docs` | PRD、功能规格、架构、数据字典、DDL、API、任务清单（**业务唯一依据**） |
| `rawdata/原始数据` | 金山文档导出的 5 份只读 JSON |
| `archive/v0_backend` | 旧版后端，仅作历史迁移参考 |
| `data` `logs` `runtime` `outputs` `monitor` `business_output` | 运行态与生成物，默认不提交 |

## 关键业务约束

写代码前必看 `docs/ERP_功能规格说明书_v1.0.md`，几条最容易踩的：

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
