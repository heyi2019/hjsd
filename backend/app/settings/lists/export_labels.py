"""lists.export_labels：导出专用的闭集系统枚举中文文案表。

口径：
- 文案事实源是前端 `shared/lib/labels.ts` / `format.ts`，这里只复制导出需要的子集，
  改前端文案时须同步本表；未知代码值一律保留原值导出，不静默吞掉新枚举；
- 管理员可编辑的字典（option_sets，D 类）不走本表，仍由 `lists.get_value_labels`
  动态查表；本表只补「没有字典行、也不该有字典行」的闭集系统枚举；
- 明细 JSON 列（操作明细/资金明细/返点明细/审计记录等）的键翻译与内部字段剔除
  也在这里定义：`DETAIL_KEY_LABELS` / `DETAIL_PRUNED_KEYS` / `NESTED_VALUE_LABELS`。
"""
from __future__ import annotations

# ---------------------------------------------------------------- 主列表列值
# {列 key: {代码值: 中文}}：主列表导出时并入 value_labels，动态字典优先于本表。
COLUMN_VALUE_LABELS: dict[str, dict[str, str]] = {
    # BusinessMode（前端 labels.ts BUSINESS_MODE_LABEL）
    "business_mode": {"SELF": "自营", "DISTRIBUTION": "分销"},
    # InventoryType（前端 labels.ts BUSINESS_TYPE_LABEL）
    "inventory_type": {"RECOVERY": "回收", "PICKUP": "提号", "CONSIGNMENT": "代挂"},
    # AccountStatus（前端 format.ts ACCOUNT_STATUS_LABEL，台账「库存状态」列）
    "account_status": {"WAITING": "在库", "SOLD": "已售", "VOID": "失效"},
    # 报表/主列表共用的机器行标记：导出翻中文，便于业务人员读表
    "row_type": {"ITEM": "明细", "TOTAL": "合计"},
}

# ---------------------------------------------------------------- 明细 JSON 键
# 明细 JSON 列里出现过的字段键 → 中文；未收录的键保留原样。
DETAIL_KEY_LABELS: dict[str, str] = {
    # 事件（操作明细）
    "event_no": "事件号",
    "event_type": "动作",
    "sale_mode": "结算方式",
    "operation_type": "运营动作",
    "rebate_type": "返点类型",
    "portion": "金额归属",
    "delivery_direction": "交付方向",
    # 资金（资金明细）
    "flow_no": "流水号",
    "category": "类别",
    "direction": "方向",
    # 返点（返点明细）
    "rebate_no": "返点单号",
    "channel": "渠道",
    "collected_on": "收到日期",
    # 通用
    "amount": "金额",
    "occurred_on": "发生日期",
    "occurred_at": "时间",
    "status": "状态",
    "reason": "原因",
    "note": "备注",
    "operator": "操作人",
    "created_at": "登记时间",
    # 审计记录
    "action": "动作",
    "entity_type": "对象类型",
    "entity_id": "对象编号",
    "actor": "操作人",
    # 关联订单
    "source_order_no": "来源订单号",
    "target_order_no": "后续订单号",
    # 分期合约 / 期次
    "inst_no": "合约号",
    "contract_type": "合约类型",
    "principal": "本金",
    "down_payment": "首付款",
    "service_fee": "服务费",
    "periods": "期数",
    "per_period_service_fee": "每期服务费",
    "per_period": "每期应收",
    "paid_amount": "已收金额",
    "waived_amount": "减免金额",
    "bad_debt_amount": "坏账金额",
    "delivered_on": "交付日期",
    "first_due_on": "首期到期日",
    "period_no": "期次",
    "due_on": "到期日",
    "due_amount": "应收金额",
    "received_amount": "已收金额",
    # 附件
    "attachment_no": "附件编号",
    "file_name": "文件名",
    "created_by": "上传人",
    # 表单扩展字段（订单扩展字段 / 分期扩展）
    "business_responsible_ids": "业务经办人",
    "delivery_responsible_ids": "交付操作人",
    "sell_delivery_responsible_ids": "卖号交付操作人",
    "operation_responsible_ids": "运营操作人",
    "bound_phone": "绑定手机号",
    "bound_phone_owner": "手机号绑定人",
    "sell_bound_phone": "卖号换绑手机号",
    "sell_bound_phone_owner": "卖号手机号绑定人",
    "intermediary_platform": "交易平台",
    "intermediary_platform_other": "其他交易平台",
    "sell_intermediary_platform": "卖号交易平台",
    "sell_intermediary_platform_other": "卖号其他交易平台",
    "intermediary_type": "中介类型",
    "sell_intermediary_type": "卖号中介类型",
    "compensation_type": "包赔类型",
    "sell_compensation_type": "卖号包赔类型",
    "consignment_platforms": "寄售平台",
    "platform_unlist_scope": "下架方式",
}

# 明细 JSON 列里不导出的内部字段：界面不展示的系统口径（id/过账标记/冲销余额等）。
# 对「订单扩展字段」等自由键空间同样生效——自定义字段不应占用这些保留键名。
DETAIL_PRUNED_KEYS: frozenset[str] = frozenset(
    {
        "id",
        "order_id",
        "pool_id",
        "offset_event_id",
        "operator_user_ids",
        "is_posted",
        "posted_at",
        "cancellable_amount",
        "form_extra",
        "nature",
        "source_type",
        "source_id",
        "installment_id",
        "request_id",
        "sha256",
        "content_type",
        "size_bytes",
        "deleted_at",
        "updated_at",
        "updated_by",
    }
)

# ---------------------------------------------------------------- 明细 JSON 值
# {JSON 字段键: {代码值: 中文}}：按字段键取值翻译，优先级高于全局表。
# {JSON 字段键: {代码值: 中文}}：按字段键取值翻译，优先级高于全局表。
NESTED_VALUE_LABELS: dict[str, dict[str, str]] = {
    # EventType（前端 format.ts executionActionLabel / EXECUTION_ACTION_LABEL）
    "event_type": {
        "BUY": "买入",
        "SELL": "售出",
        "DELIVER": "交付",
        "CANCEL": "取消",
        "OPERATE": "运营",
        "REBATE": "返点",
    },
    # SaleMode
    "sale_mode": {"FULL": "全款", "INSTALLMENT": "分期"},
    # OperationType（前端 labels.ts 同域文案）
    "operation_type": {
        "IMAGE": "更新图片",
        "DESCRIPTION": "更新描述",
        "CONSIGNMENT": "寄售",
        "UNLIST": "下架",
    },
    # 金额归属（policyConfigSchema PRINCIPAL/PROFIT）
    "portion": {"PRINCIPAL": "本金", "PROFIT": "利润"},
    # Direction
    "direction": {"IN": "收入", "OUT": "支出"},
    # 资金类别（前端 labels.ts CASHFLOW_CATEGORY_LABEL；BUY/SELL 复用「买入/售出」）
    "category": {
        "BUY": "买入",
        "SELL": "售出",
        "CANCEL": "取消退款",
        "REBATE": "返点",
        "DEPOSIT_HOLD": "押金占用",
        "DEPOSIT_RELEASE": "押金退回",
        "DEPOSIT_CANCEL": "押金取消",
        "INSTALLMENT_PAYMENT": "分期还款",
        "TRANSFER": "划转",
        "REVERSAL": "冲销",
        "OTHER": "其他",
    },
    # RebateType（后端 orders/order_detail/view/derived.py 的 _rebate_type 同文案）
    "rebate_type": {"BUY": "买号返点", "SELL": "卖号返点"},
    # 合约 / 期次 / 返点状态混排：取值域无冲突，合并一张表
    "status": {
        "OPEN": "未结算",
        "PARTIALLY_SETTLED": "部分结算",
        "SETTLED": "已结清",
        "VOID": "失效",
        "PENDING": "待处理",
        "ACTIVE": "进行中",
        "OVERDUE": "逾期",
        "DELIVERED": "已交付",
        "DEFAULTED": "已违约",
        "CLOSED": "已关闭",
        "CANCELLED": "已取消",
        "PARTIAL": "部分收款",
        "PAID": "已收齐",
        "WAIVED": "已减免",
    },
    # InstallmentContractType（前端 labels.ts VALUE_ADDED_SERVICE_LABEL：统一「分期出售」）
    "contract_type": {
        "STOCK_SALE": "分期出售",
        "PICKUP_SALE": "分期出售",
        "CONSIGNMENT_SALE": "分期出售",
    },
    # 下架方式（form_extra platform_unlist_scope）
    "platform_unlist_scope": {"SYSTEM": "本系统", "PLATFORM": "平台"},
    # 审计对象类型（前端 labels.ts ENTITY_TYPE_LABEL + 写点补充）
    "entity_type": {
        "order": "订单",
        "order_event": "订单事件",
        "account": "账号",
        "customer": "客户",
        "counterparty": "合作方",
        "installment": "分期合约",
        "pool": "资金账户",
        "cashflow": "资金流水",
        "lead": "需求",
        "deposit": "押金",
        "user": "用户",
        "team": "团队",
        "attachment": "附件",
        "option_set": "选项词典",
        "order_type": "业务类型",
        "game_type": "游戏类型",
        "reconciliation": "资金对账",
        "transfer": "资金划转",
        "field_definition": "表单字段配置",
        "list_export": "列表导出",
        "list_columns": "列表列配置",
        "policy": "分润配置",
        "inventory_order_edit": "订单编辑",
        "inventory_event_edit": "订单事件编辑",
        "inventory_cashflow_edit": "流水编辑",
    },
    # 审计动作（前端 labels.ts AUDIT_ACTION_LABEL，随枚举增补同步）
    "action": {
        "POOL_CREATE": "新建资金账户",
        "POOL_UPDATE": "编辑资金账户",
        "POOL_DISABLE": "停用资金账户",
        "POOL_DELETE": "删除资金账户",
        "ORDER_TYPE_CREATE": "新建业务类型",
        "ORDER_TYPE_UPDATE": "编辑业务类型",
        "ORDER_TYPE_DISABLE": "停用业务类型",
        "GAME_TYPE_CREATE": "新建游戏类型",
        "GAME_TYPE_UPDATE": "编辑游戏类型",
        "GAME_TYPE_DISABLE": "停用游戏类型",
        "GAME_TYPE_DEFAULT": "设置默认游戏类型",
        "LIST_COLUMNS_UPDATE": "列表列显示配置变更",
        "LIST_COLUMNS_RESET": "列表列配置恢复默认",
        "LIST_COLUMN_ADD": "列表新增自定义列",
        "LIST_COLUMN_REMOVE": "列表删除自定义列",
        "CUSTOMER_CREATE": "新建客户",
        "CUSTOMER_UPDATE": "编辑客户",
        "CONTACT_WRITE": "维护联系人",
        "CUSTOMER_MERGE": "合并客户",
        "LEAD_CREATE": "新建需求",
        "LEAD_UPDATE": "编辑需求",
        "LEAD_CONVERT": "需求转化",
        "LEAD_CLOSE": "关闭需求",
        "ACCOUNT_CREATE": "新建账号",
        "ACCOUNT_UPDATE": "编辑账号",
        "ACCOUNT_DELETE": "删除",
        "ORDER_DELETE": "删除",
        "ORDER_CREATE": "新建订单",
        "ORDER_UPDATE": "编辑订单",
        "ORDER_CANCEL": "取消",
        "LIST_EXPORT": "导出列表",
        "EVENT_CREATE": "登记订单事件",
        "EVENT_POST": "过账订单事件",
        "DEPOSIT_CREATE": "登记押金占用",
        "DEPOSIT_UPDATE": "编辑押金占用",
        "DEPOSIT_DELETE": "删除押金占用",
        "DEPOSIT_RELEASE": "释放押金",
        "DEPOSIT_LOSS": "登记押金损失",
        "DEPOSIT_CANCEL": "取消押金",
        "INSTALLMENT_CREATE": "新建分期合约",
        "INSTALLMENT_CANCEL": "取消分期合约",
        "INSTALLMENT_PAYMENT": "分期收款",
        "INSTALLMENT_EARLY_SETTLE": "提前结清",
        "INSTALLMENT_OVERDUE": "标记逾期",
        "INSTALLMENT_DEFAULT": "登记违约",
        "INSTALLMENT_WAIVE": "期次减免",
        "INSTALLMENT_EXTEND": "期次展期",
        "INSTALLMENT_RECOVER": "回收账号",
        "INSTALLMENT_RESELL": "回收转售",
        "DELIVER_CREATE": "登记交付",
        "REBATE_CREATE": "登记返点",
        "REBATE_UPDATE": "编辑返点",
        "REBATE_DELETE": "删除返点",
        "REBATE_SETTLE": "返点结算",
        "REBATE_REVERSE": "冲销返点",
        "REBATE_VOID": "取消返点",
        "RECONCILIATION_CREATE": "登记对账",
        "RECONCILIATION_RESOLVE": "处置对账差异",
        "CASHFLOW_CREATE": "登记资金流水",
        "CASHFLOW_REVERSE": "冲销流水",
        "TRANSFER_CREATE": "发起资金划转",
        "TRANSFER_REPAIR": "修复单边划转",
        "USER_CREATE": "新建用户",
        "USER_UPDATE": "编辑用户",
        "USER_DEACTIVATE": "停用用户",
        "USER_HANDOVER": "交接用户权限",
        "PASSWORD_CHANGE": "修改密码",
        "PASSWORD_RESET": "重置密码",
        "TEAM_CREATE": "新建团队",
        "TEAM_UPDATE": "编辑团队",
        "FIELD_DEFINITION_CHANGE": "变更表单字段配置",
        "ORDER_FORM_FIELD_CHANGE": "变更订单表单字段",
        "POLICY_CHANGE": "变更经营规则",
        "PROFIT_ALLOCATION_SET": "设置利润分润",
        "EXCEPTION_APPROVE": "审批异常",
        "REPORT_EXPORT": "导出报表",
        "ATTACHMENT_UPLOAD": "上传附件",
        "ATTACHMENT_DELETE": "删除附件",
        "OPTION_SET_CREATE": "新建选项词典",
        "OPTION_SET_UPDATE": "编辑选项词典",
        "OPTION_SET_DELETE": "删除选项词典",
    },
}

CASHFLOW_VALUE_LABELS: dict[str, dict[str, str]] = {
    "ledger_type": {"BUSINESS": "业务资金", "STUDIO": "工作室运营"},
    "direction": NESTED_VALUE_LABELS["direction"],
    "category": NESTED_VALUE_LABELS["category"],
    "source": {
        "MANUAL": "手工登记", "ORDER": "订单", "ORDER_EVENT": "订单事件",
        "INSTALLMENT": "分期收款", "REBATE": "返点", "DEPOSIT": "押金",
        "TRANSFER": "资金划转", "REVERSAL": "冲销",
    },
    "accounting_attribute": {
        "SELF_DIRECT_COST": "回收成本", "SELF_REVENUE": "回收收入",
        "TH_DIRECT_COST": "提号成本", "TH_REVENUE": "提号收入", "DG_REVENUE": "代挂收入",
        "SERVICE_REVENUE": "增值服务费收入", "REBATE_INCOME": "返点收入",
        "OTHER_INCOME": "其他收入", "OTHER_EXPENSE": "其他支出", "OPERATING_EXPENSE": "工作室运营支出",
        "DEPOSIT": "押金/保证金", "EXTERNAL_FUNDING": "外部资金", "INTERNAL_TRANSFER": "内部调拨",
        "REVERSAL": "冲销", "REFUND": "退款",
    },
}

__all__ = [
    "CASHFLOW_VALUE_LABELS",
    "COLUMN_VALUE_LABELS",
    "DETAIL_KEY_LABELS",
    "DETAIL_PRUNED_KEYS",
    "NESTED_VALUE_LABELS",
]
