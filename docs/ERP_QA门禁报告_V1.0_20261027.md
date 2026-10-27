# ERP QA 门禁报告 · V1.0

| 项 | 内容 |
|---|---|
| 文件编号 | `ERP_QA门禁报告_V1.0` |
| 运行域 | 黑金时代 ERP v1（backend + frontend） |
| 阅读对象 | 何一（发版决策人）、后端/前端开发 |
| 编写日期 | 2026-10-27 |
| 编写人 | Horizon · QA |
| 被测版本 | `main@85d20d2`（fix(db): 重建 teams 表补回 id NOT NULL 声明） |

---

## 一、结论前置

**当前不能签字发版。** 差两项未闭：

1. **P1 缺陷未修**：资金对账 `POST /reconciliations` 对「角分不为零」的余额组合会因 CHECK 约束浮点残差直接 500 —— 实测 5 组常见金额 3 组必炸（详见 §四 P1-01）。资金域核心功能，P1 不等于可放行。
2. **安全覆盖 0%**：OWASP Top 10 一项未测（无鉴权越权、SQL 注入、IDOR、敏感信息泄露用例）。门禁标准要求安全覆盖 ≥90%。

已执行部分质量良好：**通过率 100%**（1503 例已执行、0 失败），前端静态门禁全绿，P0 归零。

---

## 二、门禁实测结果

执行环境：`git worktree /tmp/heijin_gate @ 85d20d2`（干净 HEAD，排除并行会话 WIP 干扰），前端 `node_modules` 软链主工作区。

| # | 门禁项 | 命令 | 结果 | 判定 |
|---|---|---|---|---|
| 1 | 后端全量回归 | `pytest tests/v1 -q` | **1406 passed / 2 failed** → 补 `.env` 后 **1408 passed / 0 failed** | ✅ |
| 2 | 前端受影响模块 | `vitest run src/{rebates,pools,imports,policy}` | 10 文件 **95 passed / 0 failed** | ✅ |
| 3 | 后端静态检查 | `run_regression.py lint` | pyflakes 存量 74 条（均在基线），**零新增** | ✅ |
| 4 | 前端 UI 守卫 | `node scripts/ui_guards.mjs` | 135 页面文件，**13 条规则全过** | ✅ |
| 5 | 前端类型检查 | `tsc --noEmit` | **0 错误** | ✅ |
| 6 | 安全测试（OWASP） | — | **未执行** | ❌ |

> 第 1 项那 2 条失败为 `tests/v1/test_settings.py`，原因是干净 worktree 缺根目录 `.env`（该文件不入库）。补入后 15/15 通过，**非代码缺陷**。若后续要在 worktree 跑全量，需先 `cp .env <worktree>/`。

### 门禁标准对照

| 标准 | 要求 | 实测 | 达标 |
|---|---|---|---|
| 执行率 | 100% | 后端 100%；前端仅受影响模块（全量未跑） | ⚠️ |
| 通过率 | ≥80% | 100%（1503/1503） | ✅ |
| P0 归零 | 0 | 0 | ✅ |
| P1 归零 | 0 | **1（P1-01）** | ❌ |
| 安全覆盖 | ≥90% | **0%** | ❌ |

---

## 三、本轮覆盖范围（承接 QA500B 收口）

上一轮「6 个无写入路径枚举状态」已全部补端点，本轮验证其前后端闭环：

| 状态 | 端点 | 前端入口 | 后端契约测试 | 前端组件测试 |
|---|---|---|---|---|
| `PolicyStatus.SUPERSEDED` | `POST /policy-versions/{id}/supersede` | 政策详情草稿行「作废」 | ✅ | ✅ |
| `PolicyStatus.EXPIRED` | `POST /policies/versions/expire-sweep?on=` | 规则详情「过期清扫」（二次确认） | ✅ | ✅ |
| `RebateStatus.VOID` | `POST /rebates/{id}/void` | 返点 OPEN 行「作废」 | ✅ | ✅ |
| `DepositStatus.CANCELLED` | `POST /deposits/{id}/cancel` | 资金页 PAID 押金「取消」 | ✅ | ✅ |
| `ImportBatchStatus.REJECTED` | `POST /imports/batches/{id}/reject` | 导入工作台未确认批次「驳回」 | ✅ | ✅ |
| `CounterpartyStatus.DISABLED` | `PATCH /counterparties/{id}/status?active=false` | 合作方停用（既有） | ✅ | — |

守卫语义（均有正反用例）：SUPERSEDED 仅 DRAFT 可作废；EXPIRED 仅清 `effective_to < on` 的 ACTIVE 且幂等；VOID 仅零结算；CANCELLED 仅 PAID 且无退还/损失；REJECTED 仅 DRAFT/MAPPED 终态。

---

## 四、缺陷台账

### P1-01 · 对账 CHECK 浮点残差致 500（✅ 已修复，提交 `52e9676`，方案 A）

> **修复记录（2026-10-27 14:35）**：迁移 `0023`（`c9e2f4a6b8d0`）按 0013 后终态整表重建，CHECK 改容差 `abs(difference - (statement_balance - system_balance)) <= 0.005`；ORM `trade.py` 同步。验证：定向 109 passed（干净 worktree @0e5fc16）、CHECK 行为矩阵 7/7（小数正/负/零差放行，差 1 分/差 5 元仍拒）、空库升级降级幂等往返通过。新增回归 `test_create_reconciliation_survives_decimal_balances`。**开发库 `heijin_erp_v1.db` 待执行 `alembic upgrade head`。**

- **现象**：`POST /api/v1/reconciliations` 部分金额组合返回 500（`IntegrityError`），非 4xx。
- **根因**：`ck_reconciliations_difference_matches_balances` 定义为 `difference = statement_balance - system_balance`。SQLite 无原生 DECIMAL，`Amount`（DECIMAL(18,2)）落库即 REAL，CHECK 表达式按浮点求值；Python 侧 `to_money()` 用 Decimal 精确算。两边在「角分不为零」时必然分叉。
- **复现**（隔离 sqlite3，同 CHECK 定义）：

| statement | system | difference | SQL 浮点结果 | 结果 |
|---|---|---|---|---|
| 0.30 | 0.10 | 0.20 | 0.19999999999999998 | ❌ 500 |
| 123456.78 | 99999.99 | 23456.79 | 23456.789999999994 | ❌ 500 |
| 1.15 | 0.15 | 1.00 | 0.9999999999999999 | ❌ 500 |
| 1234.56 | 234.56 | 1000.00 | 1000.0 | ✅ |
| 10.10 | 3.30 | 6.80 | 6.8 | ✅ |

  5 组常见金额 3 组必炸——**用户拿带角分的真实流水对账，约六成概率 500**。
- **影响**：资金对账（资金域核心动作）在真实数据下不可用；已在 `QA500B` 报告中登记为「先报后改」，至今未修。
- **修复方案**（需裁决，因涉资金口径约束）：

| 方案 | 做法 | 评价 |
|---|---|---|
| **A（推荐）** | CHECK 改容差：`abs(difference - (statement_balance - system_balance)) <= 0.005` | 语义不变（半分钱内视为一致），5/5 验证通过；需重建表迁移 |
| B | CHECK 改 `difference = ROUND(statement_balance - system_balance, 2)` | 改动更小，但 `ROUND` 在半分边界行为需再验；同样需重建表 |
| C | 金额列改存整数「分」 | 根治，但全库金额列大改，超出本次范围 |

  成本提示：SQLite 无 `ALTER TABLE ADD CONSTRAINT`，须走「建新表 → 拷 → 删 → 改名」，且 `reconciliations` 被报表与流水核销引用，须纳入迁移回归。

### P2-01 · 前端全量未跑（非缺陷，覆盖缺口）

前端本次只跑受影响 4 模块（95 例）。全量约 8–10 分钟，建议在发版日一次性跑 `scripts/test-full-sharded.mjs` 补齐执行率 100%。

### P2-02 · 开发库 schema 漂移风险（部分已修）

`teams` 表漂移已由 `85d20d2` 修复（重建 + 迁移 `0021` + `test_migration` heads 更新）。**其他早期建库的环境仍可能有同类漂移**，建议对环境库统一跑一次 `alembic check`。

---

## 五、下一步（按优先级）

1. **裁决 P1-01 修复方案**（推荐 A）→ 实施后补一条「小数点对账」回归用例锁死。
2. **补 OWASP 安全测试**：至少覆盖鉴权越权（`X-Dev-User` 直通在 production 必须失效）、IDOR（跨池/跨用户读写）、审计日志篡改、敏感字段回显。这是门禁唯一硬缺口。
3. **发版日跑前端全量** + 一次完整 `alembic upgrade head` 空库演练。

---

## 附：本次实测命令留档

```bash
# 干净 HEAD worktree
git worktree add /tmp/heijin_gate HEAD --detach
ln -sfn <repo>/frontend/node_modules /tmp/heijin_gate/frontend/node_modules
cp <repo>/.env /tmp/heijin_gate/.env

# 1 后端全量
cd /tmp/heijin_gate/backend && PYTHONPATH=. <py313> -m pytest tests/v1 -q -p no:randomly
# 2 前端受影响模块
cd /tmp/heijin_gate/frontend && ./node_modules/.bin/vitest run src/rebates src/pools src/imports src/policy --reporter=dot
# 3 后端 lint（须用主 venv，worktree 无 pyflakes）
cd /tmp/heijin_gate/backend && PYTHONPATH=. <repo>/backend/.venv/bin/python3 run_regression.py lint
# 4 前端守卫
cd /tmp/heijin_gate/frontend && node scripts/ui_guards.mjs
# 5 类型检查
cd /tmp/heijin_gate/frontend && ./node_modules/.bin/tsc --noEmit
```

> 备注：`vitest --reporter=basic` 在本仓不可用（该 reporter 已从 vitest 移除），用 `dot` 或默认。
