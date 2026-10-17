# 宜游轩 ERP · 数据字典 v1.0

> **上游依据**：[PRD v1.0](ERP_PRD_v1.0.md) / [功能规格说明书 v1.0](ERP_功能规格说明书_v1.0.md) / [架构设计 v1.0](ERP_架构设计_v1.0.md)。归档旧 PRD 的字段和迁移规则已作废。

> **边界**：本字典定义新业务的固定物理契约。历史资料仅按迁移映射以参考记录导入；历史列、旧表和脏值不得扩展或改变以下新表结构。

## 固定枚举与主数据

| 字段 | 值 / 规则 |
|---|---|
| capital_type | STOCK / ZERO / CREDIT；默认取业务定义，可单笔覆盖 |
| event_type | BUY / COST / SELL / PAYMENT / DELIVER / TRANSFER / CANCEL；`DELIVER` 为分期结清后的无金额交付事件；返点不是订单事件 |
| installment.contract_type | STOCK_SALE（HS 已买入库存分期出售，可不产生分期收益）/ ADVANCE_PURCHASE（DFQ 代客户买号，每期均包含分期收益）；合约类型必须与来源订单一致 |
| installment.delivery_mode | PLATFORM_OPERATOR（平台/本方操作换绑）/ CUSTOMER_SELF（客户自行换绑）；必须留换绑凭证 |
| DG 代挂结算 | 沿用统一出售 `SELL` 事实登记卖出金额和订单利润；寄售方通过 `CONSIGNOR` 关联，平台沿用账号/出售事实的平台信息；不配置抽成比例或单独结算公式 |
| customers.status | ACTIVE / DISABLED / MERGED；MERGED 仅保留历史关联，不可作为新订单参与方 |
| nature | EXTERNAL_IN / BUSINESS_IN / BUSINESS_OUT / INTERNAL |
| ownership | OWNED / CUSTODY / THIRD_PART；后两者不计权益 |
| link_status | LINKED / UNLINKED / ORPHAN / UNLINKED_TRANSFER；禁止 AUTO_MATCHED |
| 业务/池/类别 | 主数据，可新增、停用；首批业务 HS/TH/DG/DFQ |

## 核心表

| 表 | 关键字段 | 约束 |
|---|---|---|
| pools | code, name, pool_type, ownership, status | code 不改；有流水不可删除 |
| order_type_defs / order_type_pools | code, business_mode, business_type, value_added_service, capital_type, pool_id, portion | 业务分类与资金池路由；HS=`SELF/RECOVERY`，TH=`DISTRIBUTION/PICKUP`，DG=`DISTRIBUTION/CONSIGNMENT`，DFQ=`DISTRIBUTION/INSTALLMENT/ADVANCE_PURCHASE`；`capital_type` 仅为核算维度，显式池优先 |
| pool_accounts | pool_id, account_no, account_name, account_type, ownership, opening_balance, status, note | 资金池下的实际账户；账户编号全局唯一，停用保留历史；流水通过 `pool_account_id` 追溯账户 |
| orders | order_no, order_type, capital_type, trade_date, account_id, account_snapshot, link_status | HS/TH/DG 通过 `account_id` 关联库存实体；DFQ 仅保存 `account_snapshot` 订单文本快照；汇总金额由事件派生；DG 的卖出金额和订单利润沿用统一 `SELL` 事件口径，寄售方通过 `CONSIGNOR` 关联 |
| order_events | event_no, order_id, event_type, amount, portion, occurred_on, pool_id, offset_event_id, refund_responsibility | 有资金事件必须有池；TH 用 offset 核销；退款使用 `REFUND` 事件，责任方必填，金额不得超过已收减已退 |
| customers | customer_no, display_name, contact_name, phone, wechat, qq, source, owner_id, status, tags, note | 客户主数据；微信号、QQ、手机号、备注均可填写；联系方式非唯一；停用后不可用于新订单，历史关系保留；敏感资料修改写审计 |
| customer_leads | lead_no, customer_id, request_type, budget, target, status, owner_id, converted_order_id, closed_reason, note | 客户需求池；`FIND_ACCOUNT`/`SELL_ACCOUNT`/`SPECIFIC_SEARCH`；不占用资金、不自动建单；转单后保留来源订单关系 |
| order_customer_roles | order_id, customer_id, role | `UNIQUE(order_id, customer_id, role)`；role=SELLER/BUYER/CONSIGNOR/INSTALLMENT_CUSTOMER；客户可跨订单多角色 |
| counterparties | counterparty_no, display_name, type, contact_name, phone, wechat, qq, status, note | 合作方主数据；type=PEER/SUPPLIER/PLATFORM；不与客户混用；停用后不可用于新订单 |
| order_counterparty_roles | order_id, counterparty_id, role | `UNIQUE(order_id, counterparty_id, role)`；role=PEER/SUPPLIER/PLATFORM；TH 同行、DFQ 供货方等从此关联 |
| cashflow | flow_no, pool_id, occurred_on, nature, category, direction, amount, order_id, order_event_id, deposit_id, transfer_id | 必属池；直接关联来源订单或押金；事件派生流水一对一；新 INTERNAL 成对；退款使用 `direction=OUT`、`category=REFUND`，责任方默认公司，可选客户/寄售方/平台/其他，并保留责任说明 |
| period_locks | period, locked_at, locked_by, note | `YYYY-MM` 唯一；锁定后禁止该月新增/审核业务事实，修正必须使用后续期间冲销 |
| quality_issues | issue_no, code, severity, entity_type, entity_id, status, resolution, evidence | 异常工单不直接修改业务事实；通过状态记录处置进度，关闭必须留解决方式、关闭人和审计链 |
| notifications | notification_no, recipient_user_id, notification_type, title, message, entity_type, entity_id, read_at | 系统跟进通知；按接收人隔离；来源对象只用于定位，不替代业务状态；标记已读保留通知记录 |
| attachments | attachment_no, entity_type, entity_id, file_name, storage_key, content_type, size_bytes, sha256, deleted_at | 统一业务附件索引；可关联订单、事件、资金、分期、质量异常；文件独立存储，删除保留记录与审计 |
| accounts | inventory_no, game_account, game_type, game_password, channel_region, bound_phone, has_secondary, platform, business_mode, inventory_type, buy_date, cost_amount, status, account_description, account_images, note | `inventory_no` 为 ACC 库存编号；HS/TH/DG 可关联库存账号，DFQ 不关联库存账号；`game_account` 只是游戏账号文本，库存主键始终是 `inventory_no`；手机号不可作键；滞销颜色由前端按买入日期计算，不落库风险等级；不再保留 `region`、`channels` 遗留字段。 |
| installments | inst_no, order_id, contract_type, principal, down_payment, periods, per_period, service_fee_basis, paid, status | 分期合约通过所属订单取得账号信息，不单独保存 account_id；`ADVANCE_PURCHASE` 仅 DFQ，`STOCK_SALE` 仅已买入 HS；合同层可提供每期服务费利率默认值；`service_fee_basis`=`FIXED_PRINCIPAL`（固定本金）或 `OUTSTANDING_PRINCIPAL`（实际剩余本金）；合约状态含 `PENDING`、`ACTIVE`、`OVERDUE`、`SETTLED`、`DELIVERED`、`DEFAULTED`、`CANCELLED`；违约只允许从 `OVERDUE` 登记并保留未收计划；逾期后的回收、转售为 `STOCK_SALE` 处置动作，不新增合约状态，必须保留原合约关联 |
| installment_dispositions | installment_id, account_id, action, occurred_on, related_order_id, note | 逾期/违约后的账号处置记录；`action`=`RECOVER`/`RESELL`；回收将账号恢复为 `IN_STOCK`，转售必须关联新的已登记 `SELL` 订单；一份原分期合约每类处置动作只能登记一次 |
| installment_schedules | installment_id, period_no, due_on, principal_amount, service_fee_rate, service_fee, due_amount, received_amount, waived_amount, received_on, status | 分期计划明细；`UNIQUE(installment_id, period_no)`；每期可单独配置 `service_fee_rate`，每期应收=当期本金+当期服务费；`ADVANCE_PURCHASE` 服务费必填，`STOCK_SALE` 服务费可为 0；期次状态含 `PENDING`、`PARTIAL`、`PAID`、`OVERDUE`、`WAIVED`；减免累计 `waived_amount` 且不改写原应收，展期更新 `due_on` 并通过审计保留原日期，展期不是独立状态 |
| rebate_records | rebate_no, source_order_id, rate, base_amount, collected_on, expected_on, policy_version_id, policy_snapshot, link_status | HS0001-RB01；新记录来源订单必填；预计到账日用于逾期跟进；费率与规则版本快照一并固化 |
| rebate_settlements | settlement_no, rebate_record_id, settled_on, gross_amount, platform_fee, net_amount, cashflow_id | HS0001-RB01-CF-01；毛额−手续费=净额 |
| deposits | pool_id, paid_amount, returned_amount, status, dates | 可退押金不进损益，必须关联现金流；不单独生成押金编号 |
| field_definitions / entity_extra_values | entity_type, field_key, type, options, default_value, applicable_order_types, validation_rule, active, value(JSON) | 活字段仅业务辅助信息；支持 `order`、`account`、`customer`、`installment`、`pool`、`cashflow`、`lead`、`counterparty` 八类实体；有历史值只能停用 |
| policy_definitions / policy_versions | policy_code, scope_type, scope_id, effective_from/to, config(JSON), version, status | 经营规则受控配置；已引用版本不可修改或删除，只能新建版本 |
| order_profit_allocations | order_id, allocation_type, user_id, role, allocation_rate, policy_version_id | 多人订单利润分配固定结构化记录；`allocation_type` 中 `BUY`=买号、`SELL`=售出、`OPERATION`=运营属于动作性质，`COMPANY`=公司归属，不属于动作性质；分配基数为订单利润（售出金额−买入成本−直接成本），返点收益独立核算；回收、提号、代挂的买号执行人自动绑定 `BUY`，统一售出动作执行人自动绑定 `SELL`，不能手工改选；运营动作可配置人员，公司归属不绑定人员，各项比例可独立配置，四项合计必须为 100% |

## 编号与历史参考迁移（P2）

- 主业务按类型独立递增：HS / TH / DG / DFQ + 4 位；客户为 `CUS0001`、合作方为 `CP0001`；所有编号唯一、不可改、不可复用，不强制无断号。
- 返点记录号为 `HS0001-RB01`，分次到账号为 `HS0001-RB01-CF-01`。
- 历史 89 单可按需要标 UNLINKED；19 笔返点保留未关联状态，待人工补齐来源订单；不得自动匹配。该项不阻塞新单上线。
- 蹭点→DG；氪金联盟提号/氪金提号/提号→TH；小荷包/经营池→HJ_INVEST。
- 介绍费、作图费为账号附加 COST，待人工关联订单/账号；不计运营消耗。
- 八月利润转入标 UNLINKED_TRANSFER；无原始凭证不得补另一侧划转。

## 活字段边界

可配置：标签、渠道等级、账号卖点、预计上架日、客户偏好、客户来源细分、预算、常用平台、跟进备注、合作方备注。不可配置：客户编号、称呼/昵称、微信号、QQ、手机号、订单参与关系、金额、池、收支方向、资金性质、事件/业务类型、正式关联、库存/利润/应收计算字段。参与核算的活字段必须升格为固定字段。

客户新建时以微信号、QQ、手机号查询重复候选并返回提示，不强制拦截。仅管理员可合并：选择目标客户后迁移订单参与关系、分期客户关系、需求与引用；来源客户置为 `MERGED`，保留原编号、合并来源与完整审计，不删除历史行。

## 经营规则配置边界

返点率、手续费、提成率、分期规则、库存跌价规则、多人利润分配和退款分类可配置，但必须使用 `policy_definitions / policy_versions` 与固定快照字段；DG 代挂沿用统一 `SELL` 事件，不配置抽成比例和单独结算公式；不得放入 `entity_extra_values`。
