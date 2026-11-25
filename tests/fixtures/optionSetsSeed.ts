/** 测试用选项词典，保留部分历史值及其业务行为。 */
import { optionSetsApi } from "@/shared/api/options.api";
import type { OptionItem } from "@/shared/api/types/common";
import { customerSourceOptions, intermediaryPlatformOptions } from "@fixtures/catalogOptions";

export interface SeedOptionSet {
  code: string;
  label: string;
  group: string;
  editable: boolean;
  options: OptionItem[];
}

export const OPTION_SET_SEED: SeedOptionSet[] = [
  { code: "CUSTOMER_SOURCE", label: "客户来源主数据", group: "BUSINESS", editable: true, options: customerSourceOptions },
  { code: "INVENTORY_STATUS", label: "库存状态", group: "INVENTORY", editable: false, options: [
    { value: "IN_STOCK", label: "在库" }, { value: "OUT_OF_STOCK", label: "出库" },
  ] },
  { code: "INVENTORY_BUSINESS", label: "库存业务", group: "INVENTORY", editable: false, options: [
    { value: "SELF", label: "自营" }, { value: "DISTRIBUTION", label: "分销" },
  ] },
  { code: "INVENTORY_TYPE", label: "库存类型", group: "INVENTORY", editable: false, options: [
    { value: "RECOVERY", label: "回收" }, { value: "PICKUP", label: "提号" }, { value: "CONSIGNMENT", label: "代挂" },
  ] },
  { code: "INTERMEDIARY_PLATFORM", label: "经手平台", group: "BUSINESS", editable: true, options: intermediaryPlatformOptions },
  { code: "INTERMEDIARY_TYPE", label: "中介类型", group: "BUSINESS", editable: true, options: [
    { value: "普中", label: "普中" }, { value: "包赔", label: "包赔", behavior: "COMPENSATION" },
  ] },
  { code: "COMPENSATION_TYPE", label: "包赔类型", group: "BUSINESS", editable: true, options: [
    { value: "首保", label: "首保" }, { value: "续保", label: "续保" },
  ] },
  { code: "FUND_FLOW_DIRECTION", label: "流水方向", group: "FUND", editable: false, options: [
    { value: "IN", label: "收入" }, { value: "OUT", label: "支出" },
  ] },
  { code: "FUND_FLOW_ACCOUNTING_ATTRIBUTE", label: "流水核算属性", group: "FUND", editable: false, options: [
    { value: "SELF_DIRECT_COST", label: "回收成本" }, { value: "SELF_REVENUE", label: "回收收入" }, { value: "TH_DIRECT_COST", label: "提号成本" }, { value: "TH_REVENUE", label: "提号收入" }, { value: "DG_REVENUE", label: "代挂收入" }, { value: "SERVICE_REVENUE", label: "增值服务费收入" }, { value: "REBATE_INCOME", label: "返点收入" }, { value: "OTHER_INCOME", label: "其他收入" }, { value: "OTHER_EXPENSE", label: "其他支出" }, { value: "OPERATING_EXPENSE", label: "工作室运营支出" }, { value: "DEPOSIT", label: "押金/保证金" }, { value: "EXTERNAL_FUNDING", label: "外部资金" }, { value: "INTERNAL_TRANSFER", label: "内部调拨" }, { value: "REVERSAL", label: "冲销" }, { value: "REFUND", label: "退款" },
  ] },
  /* ── 0008 补种：客户 / 订单 / 分期 / 导入 / 规则 / 质量 / 资金 / 系统 ── */
  { code: "CUSTOMER_STATUS", label: "客户状态", group: "CUSTOMER", editable: false, options: [
    { value: "ACTIVE", label: "启用中" }, { value: "DISABLED", label: "已拉黑" }, { value: "MERGED", label: "已合并" },
  ] },
  { code: "COUNTERPARTY_STATUS", label: "合作方状态", group: "CUSTOMER", editable: false, options: [
    { value: "ACTIVE", label: "进行中" }, { value: "DISABLED", label: "已拉黑" },
  ] },
  { code: "COUNTERPARTY_TYPE", label: "合作方类型", group: "CUSTOMER", editable: false, options: [
    { value: "PEER", label: "同行" }, { value: "SUPPLIER", label: "供货方" }, { value: "PLATFORM", label: "平台" },
  ] },
  { code: "LEAD_STATUS", label: "需求状态", group: "CUSTOMER", editable: false, options: [
    { value: "OPEN", label: "未结算" }, { value: "CONVERTED", label: "已转化" }, { value: "CLOSED", label: "已关闭" },
  ] },
  { code: "LEAD_TYPE", label: "需求类型", group: "CUSTOMER", editable: false, options: [
    { value: "FIND_ACCOUNT", label: "找号" }, { value: "SELL_ACCOUNT", label: "卖号" }, { value: "SPECIFIC_SEARCH", label: "指定搜索" },
  ] },
  { code: "ORDER_STATUS", label: "订单状态", group: "ORDER", editable: false, options: [
    { value: "ACTIVE", label: "进行中" }, { value: "INSTALLMENT", label: "分期中" }, { value: "COMPLETED", label: "已完成" }, { value: "CANCELLED", label: "已取消" },
  ] },
  { code: "REFUND_RESPONSIBILITY", label: "退款责任方", group: "ORDER", editable: true, options: [
    { value: "COMPANY", label: "公司" }, { value: "CUSTOMER", label: "客户" }, { value: "CONSIGNOR", label: "寄售方" }, { value: "PLATFORM", label: "平台" }, { value: "OTHER", label: "其他" },
  ] },
  { code: "ORDER_BUSINESS", label: "订单业务类型", group: "ORDER", editable: false, options: [
    { value: "HS", label: "回收" }, { value: "TH", label: "提号" }, { value: "DG", label: "代挂" },
  ] },
  { code: "ORDER_BUSINESS_MODE", label: "订单业务模式", group: "ORDER", editable: false, options: [
    { value: "SELF", label: "自营" }, { value: "DISTRIBUTION", label: "分销" },
  ] },
  { code: "INSTALLMENT_CONTRACT_TYPE", label: "分期合约类型", group: "INSTALLMENT", editable: false, options: [
    { value: "STOCK_SALE", label: "分期出售" }, { value: "PICKUP_SALE", label: "分期出售" }, { value: "CONSIGNMENT_SALE", label: "分期出售" },
  ] },
  { code: "INSTALLMENT_STATUS", label: "分期状态", group: "INSTALLMENT", editable: false, options: [
    { value: "ACTIVE", label: "还款中" }, { value: "OVERDUE", label: "逾期" }, { value: "SETTLED", label: "已结清" }, { value: "DELIVERED", label: "已交付" }, { value: "DEFAULTED", label: "违约" }, { value: "CLOSED", label: "已关闭" }, { value: "CANCELLED", label: "已取消" },
  ] },
  { code: "SCHEDULE_STATUS", label: "期次状态", group: "INSTALLMENT", editable: false, options: [
    { value: "PENDING", label: "待收" }, { value: "PARTIAL", label: "部分收款" }, { value: "PAID", label: "已收" }, { value: "OVERDUE", label: "逾期" }, { value: "WAIVED", label: "已减免" },
  ] },
  { code: "DEPOSIT_STATUS", label: "押金状态", group: "INSTALLMENT", editable: false, options: [
    { value: "PAID", label: "已付" }, { value: "PARTIALLY_RETURNED", label: "部分退还" }, { value: "RETURNED", label: "已退" }, { value: "LOST", label: "已损失" }, { value: "CANCELLED", label: "已取消" },
  ] },
  { code: "POLICY_STATUS", label: "规则版本状态", group: "POLICY", editable: false, options: [
    { value: "DRAFT", label: "草稿" }, { value: "ACTIVE", label: "已发布" }, { value: "EXPIRED", label: "已失效" }, { value: "SUPERSEDED", label: "已被取代" },
  ] },
  { code: "POLICY_SCOPE_TYPE", label: "规则适用范围", group: "POLICY", editable: false, options: [
    { value: "GLOBAL", label: "全局" }, { value: "ORDER_TYPE", label: "按业务类型" }, { value: "USER", label: "按人员" }, { value: "POOL", label: "按资金账户" },
  ] },
  { code: "RECONCILIATION_STATUS", label: "日对账状态", group: "FUND", editable: false, options: [
    { value: "OPEN", label: "未核销" }, { value: "RESOLVED", label: "已核销" },
  ] },
  { code: "REBATE_STATUS", label: "返点状态", group: "FUND", editable: false, options: [
    { value: "OPEN", label: "未结算" }, { value: "PARTIALLY_SETTLED", label: "部分结算" }, { value: "SETTLED", label: "已结清" }, { value: "VOID", label: "失效" },
  ] },
  { code: "POOL_STATUS", label: "资金账户状态", group: "FUND", editable: false, options: [
    { value: "ACTIVE", label: "进行中" }, { value: "DISABLED", label: "已停用" },
  ] },
  { code: "USER_ROLE", label: "用户角色", group: "SYSTEM", editable: false, options: [
    { value: "ADMIN", label: "系统管理员" }, { value: "OPERATOR", label: "业务经办人" }, { value: "FINANCE", label: "财务" }, { value: "AUDITOR", label: "审核人" }, { value: "VIEWER", label: "查看人" },
  ] },
  { code: "OWNER_SCOPE", label: "数据可见范围", group: "SYSTEM", editable: false, options: [
    { value: "SELF", label: "本人" }, { value: "TEAM", label: "团队" }, { value: "ALL", label: "全部" },
  ] },
  /* ── 0009 补种：资金账户主数据 / 订单角色 / 违约处置 / 字段元数据 ── */
  { code: "POOL_TYPE", label: "资金账户用途类型", group: "FUND", editable: false, options: [
    { value: "INVEST", label: "投资款" }, { value: "PROFIT", label: "利润" }, { value: "OTHER", label: "其他" },
  ] },
  { code: "ORDER_CUSTOMER_ROLE", label: "订单客户角色", group: "ORDER", editable: false, options: [
    { value: "SELLER", label: "卖方" }, { value: "BUYER", label: "买方" }, { value: "CONSIGNOR", label: "寄售方" }, { value: "INSTALLMENT_CUSTOMER", label: "分期客户" },
  ] },
  { code: "PROFIT_ROLE", label: "利润分配角色", group: "ORDER", editable: false, options: [
    { value: "OWNER", label: "业绩归属人" }, { value: "BUYER", label: "买方" }, { value: "SALES", label: "销售" }, { value: "SERVICE", label: "服务" },
  ] },
  { code: "INSTALLMENT_DISPOSITION", label: "违约处置方式", group: "INSTALLMENT", editable: false, options: [
    { value: "RECOVER", label: "回收" }, { value: "RESELL", label: "出售" },
  ] },
  { code: "ENTITY_TYPE", label: "实体类型", group: "SYSTEM", editable: false, options: [
    { value: "order", label: "订单" },
    { value: "order_event", label: "订单事件" },
    { value: "installment", label: "分期合约" },
    { value: "customer", label: "客户" },
    { value: "account", label: "账号" },
    { value: "cashflow", label: "资金流水" },
    { value: "user", label: "用户" },
    { value: "attachment", label: "附件" },
    { value: "reconciliation", label: "日对账" },
    { value: "lead", label: "客户需求" },
    { value: "order_form_field", label: "订单表单字段" },
    { value: "transfer", label: "资金划转" },
    { value: "report_export", label: "报表导出" },
    { value: "policy_version", label: "规则版本" },
    { value: "rebate_record", label: "返点记录" },
    { value: "OrderTypeDef", label: "业务类型" },
    { value: "counterparty", label: "合作方" },
    { value: "policy_definition", label: "规则定义" },
    { value: "option_set", label: "选项词典" },
    { value: "GameTypeOption", label: "游戏类型" },
    { value: "Pool", label: "资金账户" },
    { value: "Seed", label: "种子数据" },
    { value: "deposit", label: "押金" },
    { value: "pool", label: "资金账户" },
  ] },
  { code: "FIELD_TYPE", label: "字段类型", group: "FIELD", editable: false, options: [
    { value: "TEXT", label: "文本" }, { value: "NUMBER", label: "数字" }, { value: "DATE", label: "日期" }, { value: "BOOLEAN", label: "是/否" }, { value: "SELECT", label: "单选" }, { value: "MULTI_SELECT", label: "多选" },
  ] },
  { code: "AUDIT_ACTION", label: "审计动作", group: "AUDIT", editable: false, options: [
    { value: "POOL_CREATE", label: "新建资金账户" },
    { value: "POOL_UPDATE", label: "编辑资金账户" },
    { value: "POOL_DISABLE", label: "停用资金账户" },
    { value: "POOL_DELETE", label: "删除资金账户" },
    { value: "ORDER_TYPE_CREATE", label: "新建业务类型" },
    { value: "ORDER_TYPE_UPDATE", label: "编辑业务类型" },
    { value: "ORDER_TYPE_DISABLE", label: "停用业务类型" },
    { value: "GAME_TYPE_CREATE", label: "新建游戏类型" },
    { value: "GAME_TYPE_UPDATE", label: "编辑游戏类型" },
    { value: "GAME_TYPE_DISABLE", label: "停用游戏类型" },
    { value: "GAME_TYPE_DEFAULT", label: "设置默认游戏类型" },
    { value: "GAME_TYPE_DELETE", label: "删除游戏类型" },
    { value: "CUSTOMER_CREATE", label: "新建客户" },
    { value: "CUSTOMER_UPDATE", label: "编辑客户" },
    { value: "CONTACT_WRITE", label: "维护联系人" },
    { value: "CUSTOMER_MERGE", label: "合并客户" },
    { value: "LEAD_CREATE", label: "新建需求" },
    { value: "LEAD_UPDATE", label: "编辑需求" },
    { value: "LEAD_CONVERT", label: "需求转化" },
    { value: "LEAD_CLOSE", label: "关闭需求" },
    { value: "ACCOUNT_CREATE", label: "新建账号" },
    { value: "ACCOUNT_UPDATE", label: "编辑账号" },
    { value: "ORDER_CREATE", label: "新建订单" },
    { value: "ORDER_UPDATE", label: "编辑订单" },
    { value: "ORDER_CANCEL", label: "取消" },
    { value: "EVENT_CREATE", label: "登记订单事件" },
    { value: "EVENT_POST", label: "过账订单事件" },
    { value: "DEPOSIT_CREATE", label: "登记押金占用" },
    { value: "DEPOSIT_RELEASE", label: "释放押金" },
    { value: "DEPOSIT_LOSS", label: "登记押金损失" },
    { value: "DEPOSIT_CANCEL", label: "取消押金" },
    { value: "INSTALLMENT_CREATE", label: "新建分期合约" },
    { value: "INSTALLMENT_CANCEL", label: "取消分期合约" },
    { value: "INSTALLMENT_PAYMENT", label: "分期收款" },
    { value: "INSTALLMENT_EARLY_SETTLE", label: "提前结清" },
    { value: "INSTALLMENT_OVERDUE", label: "标记逾期" },
    { value: "INSTALLMENT_DEFAULT", label: "登记违约" },
    { value: "INSTALLMENT_WAIVE", label: "期次减免" },
    { value: "INSTALLMENT_EXTEND", label: "期次展期" },
    { value: "INSTALLMENT_RECOVER", label: "回收账号" },
    { value: "INSTALLMENT_RESELL", label: "回收转售" },
    { value: "DELIVER_CREATE", label: "登记交付" },
    { value: "REBATE_CREATE", label: "登记返点" },
    { value: "REBATE_SETTLE", label: "返点结算" },
    { value: "REBATE_REVERSE", label: "冲销返点" },
    { value: "REBATE_VOID", label: "取消返点" },
    { value: "RECONCILIATION_CREATE", label: "登记对账" },
    { value: "RECONCILIATION_RESOLVE", label: "处置对账差异" },
    { value: "CASHFLOW_CREATE", label: "登记资金流水" },
    { value: "CASHFLOW_REVERSE", label: "冲销流水" },
    { value: "TRANSFER_CREATE", label: "发起资金划转" },
    { value: "TRANSFER_REPAIR", label: "修复单边划转" },
    { value: "USER_CREATE", label: "新建用户" },
    { value: "USER_UPDATE", label: "编辑用户" },
    { value: "USER_DEACTIVATE", label: "停用用户" },
    { value: "USER_HANDOVER", label: "交接用户权限" },
    { value: "PASSWORD_CHANGE", label: "修改密码" },
    { value: "PASSWORD_RESET", label: "重置密码" },
    { value: "TEAM_CREATE", label: "新建团队" },
    { value: "TEAM_UPDATE", label: "编辑团队" },
    { value: "FIELD_DEFINITION_CHANGE", label: "变更表单字段配置" },
    { value: "ORDER_FORM_FIELD_CHANGE", label: "变更订单表单字段" },
    { value: "POLICY_CHANGE", label: "变更经营规则" },
    { value: "PROFIT_ALLOCATION_SET", label: "设置利润分润" },
    { value: "EXCEPTION_APPROVE", label: "审批异常" },
    { value: "REPORT_EXPORT", label: "导出报表" },
    { value: "ATTACHMENT_UPLOAD", label: "上传附件" },
    { value: "ATTACHMENT_DELETE", label: "删除附件" },
    { value: "OPTION_SET_CREATE", label: "新建选项词典" },
    { value: "OPTION_SET_UPDATE", label: "编辑选项词典" },
    { value: "OPTION_SET_DELETE", label: "删除选项词典" },
  ] },
  { code: "ORDER_EVENT_TYPE", label: "订单事件类型", group: "ORDER", editable: false, options: [
    { value: "BUY", label: "买号" },
    { value: "COST", label: "附加成本" },
    { value: "SELL", label: "售出" },
    { value: "PAYMENT", label: "回款（分期）" },
    { value: "DELIVER", label: "交付" },
    { value: "CANCEL", label: "取消" },
    { value: "REFUND", label: "退款" },
  ] },
  { code: "REBATE_TYPE", label: "返点类型", group: "FUND", editable: false, options: [
    { value: "BUY", label: "买号返点（对应回收/提号）" },
    { value: "SELL", label: "卖号返点（对应售出）" },
  ] },
  { code: "SEQUENCE_KEY", label: "编号域", group: "SYSTEM", editable: false, options: [
    { value: "ORDER_HS", label: "回收编号" },
    { value: "ORDER_TH", label: "提号编号" },
    { value: "ORDER_DG", label: "代挂编号" },
    { value: "CUSTOMER", label: "客户" },
    { value: "COUNTERPARTY", label: "合作方" },
    { value: "LEAD", label: "需求" },
    { value: "NOTIFICATION", label: "通知" },
    { value: "CASHFLOW_OUT", label: "支出流水" },
    { value: "CASHFLOW_IN", label: "收入流水" },
    { value: "STOCK_NO", label: "库存编号" },
  ] },
  { code: "POLICY_TYPE", label: "规则编码", group: "POLICY", editable: false, options: [
    { value: "REBATE", label: "REBATE 返点" },
    { value: "COMMISSION", label: "COMMISSION 提成" },
    { value: "INSTALLMENT", label: "INSTALLMENT 分期" },
    { value: "WRITE_DOWN", label: "WRITE_DOWN 跌价" },
    { value: "REFUND", label: "REFUND 退款" },
    { value: "DG_MIXED", label: "DG_MIXED DG 混合单默认策略" },
  ] },
  { code: "ALLOCATION_TYPE", label: "归属动作", group: "ORDER", editable: true, options: [
    { value: "BUY", label: "买号" },
    { value: "SELL", label: "售出" },
    { value: "OPERATION", label: "运营" },
    { value: "COMPANY", label: "公司归属" },
  ] },
  { code: "REPORT_NAME", label: "报表名称", group: "REPORT", editable: false, options: [
    { value: "monthly-pnl", label: "月度损益" },
    { value: "commission", label: "提成对账" },
    { value: "business-pnl", label: "业务损益" },
    { value: "order-profit", label: "订单利润" },
  ] },
];

/** 桩 optionSetsApi.list 返回完整种子，供库存/资金筛选器测试拿到筛选项。 */
export function seedOptionSets(): void {
  const payload = {
    items: OPTION_SET_SEED.map((set, index) => ({
      id: index + 1,
      ...set,
      options: set.options.map((option) => ({ ...option })),
    })),
  };
  (optionSetsApi.list as unknown as { mockResolvedValue(value: unknown): void }).mockResolvedValue(payload);
}


