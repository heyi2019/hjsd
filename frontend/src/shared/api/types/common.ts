/** 通用响应外壳、字典选项、附件与通知。
 * 按领域拆分的独立类型模块；从本文件路径直接导入。
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
  behavior?: "OTHER" | "COMPENSATION";
  disabled?: boolean;
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

export interface CustomDictionaryField {
  field_id: number;
  order_type_code: string;
  field_key: string;
  field_label: string;
  scope_label: string;
  field_type: string;
  is_active: boolean;
}

export interface CustomDictionary extends CustomDictionaryField {
  label: string;
}

export interface CustomDictionaryCatalog {
  items: CustomDictionary[];
  available_fields: CustomDictionaryField[];
}

export interface DocumentSequence {
  sequence_key: string;
  prefix: string;
  padding: number;
  current_value: number;
  next_number: string;
  display_label?: string | null;
  display_prefix?: string | null;
  remaining?: number | null;
  near_exhaustion?: boolean;
}

export interface AttachmentItem { id: number; file_name: string; size_bytes: number; created_by: string }


export interface NotificationItem {
  id: number;
  notification_no?: string;
  recipient_user_id?: number;
  notification_type?: string;
  title: string;
  message: string;
  entity_type: string;
  entity_id: string;
  created_by?: string;
  created_at?: string;
  read_at?: string | null;
}
