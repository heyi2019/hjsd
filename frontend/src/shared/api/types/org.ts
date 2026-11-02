/** 游戏类型与人员/团队选择器。
 * 由原 shared/api/types.ts 按领域拆分；对外仍从 `./types` 统一导入。
 * 金额一律以字符串传输，前端不做浮点数计算。 */

export interface GameTypeOption {
  id: number;
  name: string;
  sort_order: number;
  is_active: boolean;
  is_default: boolean;
  channel_regions?: string[];
}

export interface EmployeeOption { id: number; username: string; display_name: string; is_active: boolean }

export interface ManagedUser extends EmployeeOption {
  role: string;
  owner_scope: string;
  pool_ids: number[];
  team_ids: number[];
  must_change_password: boolean;
}

export interface Team {
  id: number;
  code: string;
  name: string;
  description?: string | null;
  is_active: boolean;
}
