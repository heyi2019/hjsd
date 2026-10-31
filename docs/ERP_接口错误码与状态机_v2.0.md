# 宜游轩 ERP · 状态机与接口错误码 v2.0

> 本文补充 [API 接口规范](ERP_API接口规范_v1.2.md)。状态变化只能由 Service 事务触发；前端根据权限、当前状态和接口返回控制按钮，不得自行推算财务状态。
>
> **权威来源**：`backend/app/core/state_machine.py`（`ORDER_TRANSITIONS` / `ACCOUNT_TRANSITIONS` / `INSTALLMENT_TRANSITIONS`）与 `app/domain/enums.py`。本文与代码逐条对齐。

## 1. 通用错误结构

```json
{"code":"ORDER_STATUS_CONFLICT","message":"当前订单不能登记该事件","details":{"order_no":"HS0001","current_status":"COMPLETED"}}
```

| HTTP | code | 前端处理 |
|---:|---|---|
| 401 | `AUTH_REQUIRED` / `TOKEN_EXPIRED` | 跳转登录并保存当前页面 |
| 403 | `PERMISSION_DENIED` | 提示无权限，不展示重试写入 |
| 404 | `RESOURCE_NOT_FOUND` | 返回列表并刷新 |
| 405 | `METHOD_NOT_ALLOWED` | 检查当前接口动作 |
| 409 | `ORDER_STATUS_CONFLICT` / `VERSION_CONFLICT` | 刷新详情后重新操作 |
| 422 | `VALIDATION_ERROR` | 标记具体字段 |
| 422 | `POOL_ROUTE_MISSING` | 提示管理员补资金池路由 |
| 422 | `PARTICIPANT_ROLE_INVALID` | 提示更换客户/合作方角色 |
| 422 | `CUSTOMER_DISABLED` / `COUNTERPARTY_DISABLED` | 不允许引用停用参与方 |
| 422 | `INSTALLMENT_TYPE_INVALID` | 合约类型与订单不匹配（STOCK_SALE↔HS / PICKUP_SALE↔TH / CONSIGNMENT_SALE↔DG） |
| 422 | `PAYMENT_EXCEEDS_RECEIVABLE` | 刷新应收后重新填写 |
| 422 | `DELIVERY_CONDITION_UNMET` | 补结清、审批或交付凭证 |
| 422 | `EVENT_CASHFLOW_EXISTS` | 不允许重复登记 |
| 422 | `MERGE_TARGET_INVALID` | 选择其他有效客户作为目标 |

## 2. 订单状态（4 态）

| 状态 | 含义 | 可执行动作 | 禁止 |
|---|---|---|---|
| `ACTIVE` | 可继续登记业务事件 | `INSTALLMENT`（转分期）、`COMPLETE`、`CANCEL` | 删除已发生事件 |
| `INSTALLMENT` | 已挂分期合约，回款中 | `COMPLETE`、`CANCEL` | 重复登记分期 |
| `COMPLETED` | 业务闭环 | `BUY`（撤销售出，回退 `ACTIVE`）、`CANCEL` | 新增普通 BUY/SELL/PAYMENT |
| `CANCELLED` | 已按冲销规则取消 | 无 | 重新启用原单；应新建订单 |

订单创建即为 `ACTIVE`（不设草稿态：订单不挂金额，空壳草稿无业务信息）。已产生现金流的事件不能删除，只能用 `CANCEL` / offset 事件按原池、原日期冲销。`CANCELLED` 为终态。

## 3. 库存账号状态（3 态，生命周期轴）

`stocks.status` 是账号生命周期，与库存在场状态 `inventory_status`（`IN_STOCK` / `OUT_OF_STOCK`）是**两条独立轴**，不得混用。

| 当前 | 动作 | 下一状态 | 说明 |
|---|---|---|---|
| `WAITING` | `BUY_STOCK` | `WAITING` | 自营买入后保留在库 |
| `WAITING` | `BUY_CREDIT` | `SOLD` | 分期型买入 |
| `WAITING` | `SELL` | `SOLD` | 全款售出 |
| `WAITING` | `VOID` | `VOID` | 作废 |
| `SOLD` | `BUY_STOCK` | `WAITING` | 售出撤销后重新入库 |
| `SOLD` | `BUY_CREDIT` | `SOLD` | 撤销后重新进入分期型买入 |
| `SOLD` | `RECOVER` | `WAITING` | 分期逾期回收 |
| `SOLD` | `CANCEL_STOCK` | `WAITING` | 买入事实被取消 |
| `SOLD` | `CANCEL_SELL` | `WAITING` | 售出冲销 |
| `SOLD` | `CANCEL_SELL_END` | `VOID` | 售出冲销且业务终止 |
| `SOLD` | `VOID` | `VOID` | 作废 |
| `VOID` | — | — | 终态，拒绝一切业务动作 |

同一 `game_account` 可反复买入，每次收购都是独立实体，`game_account` **不唯一**。

## 4. 分期合约状态（8 态）

| 状态 | 进入条件 | 允许动作 |
|---|---|---|
| `PENDING` | 合约创建、首付未确认 | `PAYMENT`→ACTIVE、`MARK_OVERDUE`、`SETTLE`、`CANCEL` |
| `ACTIVE` | 已有应收计划 | `PAYMENT`、`MARK_OVERDUE`、`SETTLE`、`DEFAULT`、`CANCEL` |
| `OVERDUE` | 到期未足额收款 | `PAYMENT`、`SETTLE`、`DEFAULT`、`CLOSE`、`CANCEL` |
| `SETTLED` | 所有应收已收或受控减免 | `DELIVER`→DELIVERED、`CANCEL` |
| `DELIVERED` | 已生成无金额 `DELIVER` | 只读 |
| `DEFAULTED` | 仅可从 `ACTIVE` / `OVERDUE` 登记违约 | `PAYMENT`（追偿收款）、`CLOSE` |
| `CLOSED` | 逾期或违约后关闭结案 | 只读，终态 |
| `CANCELLED` | 无资金事实时取消 | 只读，终态 |

`DELIVER` 只能从 `SETTLED` 进入 `DELIVERED`，必须提供 `delivery_mode=PLATFORM_OPERATOR` 或 `CUSTOMER_SELF` 及凭证。`PAYMENT` 是收入事实；`DELIVER` 不生成现金流、不再确认收入。

**期次状态**（`installment_schedules.status`）：`PENDING` / `PARTIAL` / `PAID` / `OVERDUE` / `WAIVED`。每期 `due_amount` = 当期本金 + 当期服务费；减免累计 `waived_amount` 不改写原应收；展期只更新 `due_on`，不是独立状态。

**处置动作**（`installment_dispositions.action`）：`RECOVER` / `RESELL`，同一合约每类动作只能登记一次。

## 5. 资金流水状态

| 状态 | 含义 | 允许动作 |
|---|---|---|
| `PENDING` | 待审核 | `APPROVED`、`REJECTED` |
| `APPROVED` | 已审核，计入池余额 | 经 `reversal_of_id` 冲销 |
| `REJECTED` | 已拒绝，不计入余额 | 只读 |

系统余额 = 池内 `APPROVED` 流水有符号和。冲销不删除原流水，反向生成成对记录；内部划转经共享 `transfer_id` 一出一入，直接为 `APPROVED`，无独立草稿态。

## 6. 客户、合作方与押金状态

| 对象 | 状态 | 规则 |
|---|---|---|
| 客户 | `ACTIVE` / `DISABLED` / `MERGED` | `DISABLED`、`MERGED` 不得新建订单参与关系；历史可查；合并目标须 `ACTIVE`，来源置 `MERGED` 并保留 `merged_into_id` |
| 合作方 | `ACTIVE` / `DISABLED` | 停用后不可参与新订单；有历史不可物理删除 |
| 押金 | `PAID` / `PARTIALLY_RETURNED` / `RETURNED` / `LOST` / `CANCELLED` | `returned_amount` 不得大于 `paid_amount`；缴退均有现金流；`LOST` 为损失核销 |

客户创建遇重复只返回 `duplicate_candidates` 提示，**不拦截**；仅管理员可合并，并迁移订单参与关系、分期客户关系、需求与引用。

## 7. 其他对象状态

| 对象 | 状态 |
|---|---|
| 返点记录 | `OPEN` / `PARTIALLY_SETTLED` / `SETTLED` / `VOID` |
| 导入批次 | `DRAFT` / `MAPPED` / `COMMITTED` / `REJECTED` / `ROLLED_BACK` / `CORRECTED` |
| 导入行 | `PENDING` / `MAPPED` / `UNMAPPED` / `IMPORTED` / `SKIPPED` / `ROLLED_BACK` |
| 质量工单 | `OPEN` / `IN_PROGRESS` / `CLOSED` |
| 客户需求 | `OPEN` / `CONVERTED` / `CLOSED` |
| 对账 | `OPEN` / `RESOLVED` |
| 经营规则 | `DRAFT` / `ACTIVE` / `EXPIRED` / `SUPERSEDED` |

## 8. 已移除的状态与动作（勿再引用）

- **账期锁定**（`period_locks` 表、`finance.period.lock` 权限点、"锁定账期"按钮）：已由 dev 彻底移除，前端面板、注册表项与后端表/权限点均已删除。
- **代分期相关**：`ADVANCE_PURCHASE` 合约类型、`DFQ_PRINCIPAL` 核算属性、`ORDER_DFQ` 编号域、DFQ 订单状态路径均随 DFQ 下线移除。
- **订单草稿态**：2026-10-13 移除。
