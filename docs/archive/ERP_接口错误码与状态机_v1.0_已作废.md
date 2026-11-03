# ERP 接口错误码与状态机 v1.0

> 本文补充 [API 接口规范](ERP_API接口规范_v1.1_已作废.md)。状态变化只能由 Service 事务触发；前端根据权限、当前状态和接口返回控制按钮，不得自行推算财务状态。

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
| 422 | `INSTALLMENT_TYPE_INVALID` | 合约类型与订单不匹配 |
| 422 | `PAYMENT_EXCEEDS_RECEIVABLE` | 刷新应收后重新填写 |
| 422 | `DELIVERY_CONDITION_UNMET` | 补结清、审批或交付凭证 |
| 422 | `EVENT_CASHFLOW_EXISTS` | 不允许重复登记 |
| 422 | `MERGE_TARGET_INVALID` | 选择其他有效客户作为目标 |

## 2. 订单状态

| 状态 | 含义 | 可进入 | 禁止 |
|---|---|---|---|
| `ACTIVE` | 可继续登记业务事件 | `COMPLETED`、`CANCELLED` | 删除已发生事件 |
| `COMPLETED` | 业务闭环 | 仅受控冲销/更正 | 新增普通 BUY/SELL/PAYMENT |
| `CANCELLED` | 未完成或已按冲销规则取消 | 无 | 重新启用原单；应新建订单 |

订单创建即为 `ACTIVE`（2026-10-13 移除草稿态：订单不挂金额，空壳草稿无业务信息）。已产生现金流的事件不能删除，只能用 `CANCEL` / offset 事件按原池、原日期规则冲销。

## 3. 分期状态

| 状态 | 进入条件 | 允许动作 |
|---|---|---|
| `PENDING` | 合约创建、首付未确认 | 收首付、作废 |
| `ACTIVE` | 已有应收计划 | PAYMENT、展期、减免、标逾期 |
| `OVERDUE` | 到期未足额收款 | PAYMENT、展期、减免、违约处置 |
| `SETTLED` | 所有应收已收或受控减免 | 选择交付方式、登记换绑凭证、DELIVER |
| `DELIVERED` | 已生成无金额 `DELIVER` | 只读、受控更正 |
| `DEFAULTED` | 授权违约处置 | 风险追踪、后续追偿收款 |
| `CANCELLED` | 无资金事实时取消，或已按冲销规则处理 | 只读 |

`DELIVER` 只允许从 `SETTLED` 进入 `DELIVERED`，必须提供 `delivery_mode=PLATFORM_OPERATOR` 或 `CUSTOMER_SELF` 和凭证。`PAYMENT` 是收入事实；`DELIVER` 不生成现金流、不再确认收入。

## 4. 客户、合作方和押金状态

| 对象 | 状态 | 规则 |
|---|---|---|
| 客户 | `ACTIVE` / `DISABLED` / `MERGED` | `DISABLED`、`MERGED` 不得新建订单参与关系；历史可查 |
| 合作方 | `ACTIVE` / `DISABLED` | 停用后不可参与新订单；有历史不可物理删除 |
| 押金 | `PAID` / `PARTIALLY_RETURNED` / `RETURNED` / `CANCELLED` | `returned_amount` 不得大于 `paid_amount`；缴退均有现金流 |

客户创建重复只返回 `duplicate_candidates`；不改变状态。合并仅管理员可做，目标必须 `ACTIVE`，来源改为 `MERGED`，并迁移关联关系与审计。
