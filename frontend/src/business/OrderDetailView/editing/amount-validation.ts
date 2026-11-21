/** 订单详情的金额输入允许编辑中暂时为空，但保存时必须是非负金额。 */
export function isValidEditedMoney(value: string): boolean {
  return /^\d+(?:\.\d{1,2})?$/.test(value);
}
