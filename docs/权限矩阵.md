# 宜游轩 ERP · 权限矩阵 v2.0

> 权限为「角色权限 + 数据范围」两层。角色决定能否执行动作；数据范围决定可见哪些订单、客户、资金池和报表。默认最小授权，所有高风险动作写审计。
>
> **权威清单**：`backend/app/core/security.py` 的 `ALL_PERMISSIONS`（25 点）与 `ROLE_PERMISSIONS`。本文为逐点对齐版，若与代码不一致以代码为准并回改本文。

## 1. 角色定义

| 代码 | 角色 | 典型职责 | 权限点数 |
|---|---|---|---:|
| `ADMIN` | 系统管理员 | 用户、团队、主数据、活字段、选项词典、客户合并、导入 | 25（全部） |
| `OPERATOR` | 业务经办人 | 建客户、建单、登记业务事件 | 12 |
| `FINANCE` | 财务 | 资金流水、划转、押金、对账、财务侧事件 | 10 |
| `AUDITOR` | 业务审核人 | 经营规则维护、审计查阅、报表 | 8 |
| `VIEWER` | 经营查看人 | 只读报表与资金汇总 | 2 |

数据范围由 `owner_scope`（`SELF` / `TEAM` / `ALL`）+ `pool_ids` + `team_ids` 决定，与角色正交：角色管「能不能做」，范围管「对谁做」。

## 2. 权限点全集（25 点）

| # | 权限点 | ADMIN | OPERATOR | FINANCE | AUDITOR | VIEWER | 判定要点 |
|---:|---|:--:|:--:|:--:|:--:|:--:|---|
| 1 | `customer.read` | ✔ | ✔ | ✔ | ✔ | — | 默认返回脱敏微信、QQ、手机号 |
| 2 | `customer.contact.read` | ✔ | ✔ | ✔ | ✔ | — | 读取完整联系方式；访问写审计 |
| 3 | `customer.create` | ✔ | ✔ | — | — | — | 只能写范围内客户 |
| 4 | `customer.update` | ✔ | ✔ | — | — | — | 停用与合并外的字段变更 |
| 5 | `customer.contact.write` | ✔ | ✔ | — | — | — | 改联系方式、备注；记录变更前后值 |
| 6 | `customer.merge` | ✔ | — | — | — | — | 仅管理员；须填原因，来源置 `MERGED` |
| 7 | `counterparty.read` | ✔ | ✔ | ✔ | ✔ | — | 合作方只读 |
| 8 | `counterparty.manage` | ✔ | — | — | — | — | 仅管理员可新增、停用合作方 |
| 9 | `order.create` | ✔ | ✔ | — | — | — | 必须校验客户/合作方角色 |
| 10 | `order.update` | ✔ | ✔ | — | — | — | 不改已发生事件 |
| 11 | `order.event.post` | ✔ | ✔ | — | — | — | 经办人侧登记事件；金额事件原子生成现金流 |
| 12 | `finance.order.event.post` | ✔ | — | ✔ | — | — | 财务侧登记回款/付款；与 11 分离，经办人只有 11 |
| 13 | `finance.read` | ✔ | ✔ | ✔ | ✔ | ✔ | 明细按 `pool_ids` 过滤 |
| 14 | `deposit.post` | ✔ | — | ✔ | — | — | 押金占用、释放、损失 |
| 15 | `finance.transfer` | ✔ | — | ✔ | — | — | 划转原子生成一出一入 `APPROVED` 流水 |
| 16 | `policy.manage` | ✔ | — | — | ✔ | — | 规则只能新版本生效，已发布版本不可改 |
| 17 | `field-definition.manage` | ✔ | — | — | — | — | 不得创建核算字段 |
| 18 | `audit.read` | ✔ | — | ✔ | ✔ | — | 审计日志不可编辑或删除 |
| 19 | `pool.manage` | ✔ | — | — | — | — | 资金池增停；有流水不可删 |
| 20 | `order-type.manage` | ✔ | — | — | — | — | 业务类型与资金路由 |
| 21 | `report.read` | ✔ | ✔ | ✔ | ✔ | ✔ | R1–R5、订单利润 |
| 22 | `report.export` | ✔ | ✔ | ✔ | ✔ | — | CSV 导出（含自定义列明细字段） |
| 23 | `import.manage` | ✔ | — | — | — | — | 导入批次、映射、提交、回滚、更正 |
| 24 | `user.manage` | ✔ | — | — | — | — | 用户与团队；改密走后端二次校验 |
| 25 | `option-set.manage` | ✔ | — | — | — | — | 选项词典；仅 `editable=true` 的组可改 |

> 已删除的权限点（v1.0 曾列出，代码中不存在，勿再引用）：`finance.period.lock`（账期锁定已由 dev 彻底移除，前端面板与注册表项、后端表与权限点均已删除）、`order.exception.approve`、`policy.approve`。异常审批能力现由 `AUDITOR` 角色 + `policy.manage` 承载，审计动作为 `EXCEPTION_APPROVE`。

## 3. 数据范围与脱敏

| 对象 | 范围依据 | 无完整权限时显示 |
|---|---|---|
| 客户 | `owner_id` / 团队 | 手机 `138****0000`；微信、QQ 局部遮罩 |
| 订单 | `owner_id` / 团队 | 仅可见范围内订单及关联对象 |
| 库存账号凭证 | `order.create` + 账号可见范围 | 无订单操作权限时 `game_password` 置空；账号基础资料仍按库存范围返回 |
| 资金池 | 授权 `pool_ids` | 空集表示无池授权，明细接口返回空 |
| 报表 | 团队 + 资金池范围 | 无 `finance.read` 时不展示金额明细 |

权限不足统一返回 `403 PERMISSION_DENIED`；越权对象不泄露是否存在，返回 `404 RESOURCE_NOT_FOUND`。

## 4. 必写审计的动作

联系人字段读写、客户合并、资金动作（流水/划转/押金/冲销）、规则变更、订单事件过账、活字段与表单字段变更、选项词典变更、导入提交与回滚、报表导出、附件上传删除 —— 均落 `audit_logs`，`action` 取 `AuditAction` 闭集。
