/** 订单详情金额与后端 DECIMAL(18,2) 输入限制保持一致。 */
export function editedMoneyError(value: string): string | undefined {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return "请输入金额";
  const integer = value.split(".")[0].replace(/^0+/, "");
  return integer.length > 16 ? "金额整数部分最多16位" : undefined;
}
