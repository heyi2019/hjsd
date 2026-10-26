/** 经营规则面板的本地常量（已同步到后端 enums / 选项词典，仅作词典未加载时的回落）。 */

export const SCOPE_OPTIONS: { value: string; label: string }[] = [
  { value: "GLOBAL", label: "全局" },
  { value: "ORDER_TYPE", label: "按业务类型" },
  { value: "USER", label: "按人员" },
  { value: "POOL", label: "按资金池" },
];

/** 规则编码必须与后端 PolicyType 一致：后端按固定编码消费快照（返点/提成/分期），
 * 编码拼错不会报错，只会静默取不到规则，因此这里强制枚举选择。 */
export const POLICY_CODE_OPTIONS: { value: string; label: string }[] = [
  { value: "REBATE", label: "REBATE 返点" },
  { value: "COMMISSION", label: "COMMISSION 提成" },
  { value: "INSTALLMENT", label: "INSTALLMENT 分期" },
  { value: "WRITE_DOWN", label: "WRITE_DOWN 跌价" },
  { value: "REFUND", label: "REFUND 退款" },
  { value: "DG_MIXED", label: "DG_MIXED DG 混合单默认策略" },
];

export const today = () => new Date().toISOString().slice(0, 10);
