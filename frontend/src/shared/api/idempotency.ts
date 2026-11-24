/** 仅对支持幂等的写接口设置请求头，键由操作草稿持有。 */
export function idempotencyConfig(key?: string) {
  return key ? { headers: { "Idempotency-Key": key } } : undefined;
}
