/** 通用响应外壳、字典选项与通知。
 * 由原 shared/api/types.ts 按领域拆分；对外仍从 `./types` 统一导入。
 * 金额一律以字符串传输，前端不做浮点数计算。 */

export interface PageResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface OptionItem {
  value: string;
  label: string;
}

export interface OptionSet {
  id: number;
  code: string;
  label: string;
  group: string;
  /** true=纯字典可编辑；false=后端死枚举只读 */
  editable: boolean;
  options: OptionItem[] | null;
  description?: string | null;
}

export interface OptionSetList {
  items: OptionSet[];
}

export interface NotificationItem { id: number; notification_no?: string; notification_type?: string; title: string; message: string; entity_type: string; entity_id: string; read_at?: string | null }
