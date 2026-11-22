# AGENTS.md — 宜游轩ERP（黑金时代）AI 协作契约

> 本文件是仓库内的 rubric + runbook。任何 AI agent（WorkBuddy / Copilot / Codex / 其他）在本仓库写代码前必须读完并遵守。
> 口径权威来源：`docs/数据字典.md` §8。本文件与之冲突时，以数据字典为准并立即修正本文件。

## 0. 项目身份与技术栈

- 产品：宜游轩ERP（内部代号黑金时代）。前端 HashRouter `#/xxx`，无 pages/ 目录，无 h5/。
- 后端：FastAPI + SQLAlchemy + PostgreSQL，入口 `app/main.py`，API 前缀 `/api/v1`。
- ORM 模型在 `app/domain/`，**不改名 models 文件**。业务域：`orders` / `finance` / `reporting` / `customer_center` / `field_definitions` / `stocks` / `installments` / `auth` / `lists`。
- 全站兼容层（service.py 门面、catalog.ts/types.ts 聚合桶）**已全清**，不要重建。

## 1. 业务口径铁律（违反 = 口径错，CI 不一定拦得住）

- **利润** = 单订单全部收入 − 全部支出（可正 / 负 / 0）。权威实现 `app/shared/order_amounts.py::order_cashflow_profit`。收入 = 流水 IN + 返点；支出 = 流水 OUT + 分期坏账。**禁 SELL−BUY−COST 推分润**；`total` ≠ `principal + profit`。
- **报表同源**：`reporting/_shared.py::cashflow_totals_by_order` + `shared/order_amounts.py`。返点是收入的「其中项」，禁重复相加；冲销呈毛额。
- **资金中心**：`orders/pools.py` + `reporting/funds.py` 只有收入 IN / 支出 OUT；业务名词全是「其中项」。内部划转 = 划出 OUT + 划入 IN（同 transfer_id）。`available = cash_balance`（押金占用已进 expense，不二次减）。
- **押金一套逻辑**：净额 = 收入 − 支出，+ 利润 / − 损失（**损失 = −利润，不是第二笔现金流出**）。交押金 OUT(DEPOSIT_HOLD)、退回/取消 IN；判定用 `shared/order_amounts.py::business_cashflow_filter()`。
- **押金两类账簿**：`deposits.ledger_type` 区分 `BUSINESS`（业务押金，挂 counterparty_id，source_order_id 可选）与 `STUDIO`（工作室运营押金，**禁挂 source_order_id**）。四条派生流水 HOLD/RELEASE/LOSS/CANCEL 同账簿。两类都不进损益、不二次扣可用余额；**STUDIO 押金不进工作室收支面板**。加押金列表列须三点联动：前端 tsx + `lists/scopes.py` DEPOSITS registry + parity 测试。
- **返点无作废/删除**：登记即确认收入，退回走真实 OUT（`POST /cashflows` 或 `POST /orders/{id}/cashflows`）。金额唯一取 `rebate_records.base_amount`，`rate` 只留痕。
- **售出返点不限订单类型**：DG 代挂同样有售出返点；仅买号返点 BUY 限 HS/TH。
- **DFQ 已下线**：仅 HS/TH/DG；CapitalType 仅 STOCK/ZERO；编号 HS/TH/DG+4、流水 ZC/SR+5、NTF≤9999。
- **核算属性 15 值**：以 `domain/enums.py::AccountingAttribute` 为准；前端文案唯一源 `labels.ts::ACCOUNTING_ATTRIBUTE_LABEL`。「附加收入/支出」「自营」「代挂成本」概念已废弃。改枚举必须四库原地 DROP → 回填 → ADD。工作室收入锚 SELF_REVENUE。
- **客户角色按单判定**：`order_customer_roles.role` + 白名单 `orders/_shared.py::_CUSTOMER_ROLES_BY_ORDER_TYPE`；**禁给 customers 加类型列**。
- **库存**：`stocks`（`stock_no` = KU_+5）；`game_password` 明文勿加密；售出表单 SALEREC / SALETH / SALEDG（旧 `SALE` 即缺陷）。

## 2. 动手前必查（否则会出事故）

- **测试库铁律**：跑测试前必须核 `TEST_DATABASE_URL` ≠ dev（应 `heijin_erp_test`）。`conftest` TRUNCATE 全表，曾误清 dev 118 单。**只跑针对性测试**，禁动不动全量。
- Python：服务/lint 用 `backend/.venv/bin/python3`；SQLAlchemy + pytest 唯一用 `/Users/aries/Applications/Python_3.13/bin/python3`。端口：8123 dev / 8125 main、前端 5188 / 5199。
- **金额**：用 `Amount` + `to_money()`，禁 float；写路径走 Service 事务 + `record_audit`；按月聚合走 Python 层 `reporting/_shared.py::_month_key()`，禁 `func.strftime` / `func.json_extract`。
- **迁移/发布**：活动链只剩基线 0001（create_all + seed_catalog），改 ORM 即改基线，**不加增量迁移**，落后库绝不 stamp；上线走原地增量。`push origin/main` = 上线，须单独确认；分支只留 main/dev；`RELEASE.md` 不可删。
- **分层**：`core`(L0，零 ORM) → `domain`(L1) → `shared`(L2，跨域原语) → 业务域(L3)。`backend/.importlinter` 5 契约必须全绿；改 import 前先查 `app/shared/`；环检测必须用 AST，正则会漏。
- **拆分纪律**：拆测试文件须同步 4 处元数据（`tests/manifest.json`、`tests/config/catalog.py::BACKEND_FILE_TO_FUNC`、`docs/testing/测试元数据台账.csv`、`backend/run_regression.py::GROUPS`）。
- 前端：antd Modal 禁嵌受控 Modal children；`.login-card` 固定深色；≤640px 按列 key 打标 `ui-col-mobile-hide`，禁 nth-child；控件高 36px；`useSession()` user→role+username。
- 提交：先 `git status --short`；只 pathspec 暂存；禁 `git add -A` / `--no-verify`；不 push 除非明确要求。

## 3. GitHub CI 闭环（验收场）

- `.github/workflows/`：`backend-gate` / `frontend-gate` / `lint-gate` / `main-ci-cd` / `deploy-production` / `rollback`。
- main 的 push 由 `main-ci-cd` 在 release sha 上统一 dispatch 三道门禁，再触发生产部署；PR 直接触发门禁。
- CI 能拦语法、pyflakes、测试回归；**拦不住业务语义跑偏**——第 1 节的口径必须靠 agent 自觉遵守。
