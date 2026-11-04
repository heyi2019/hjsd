/**
 * H5 权限判定：与桌面端 `shared/state/session.tsx` 的 ROLE_PERMISSIONS 同源。
 *
 * 两点必须对齐的口径：
 *  1) 后端 `/auth/me` 下发的 role 是**大写**（ADMIN / OPERATOR …），桌面端在
 *     `user.role.toLowerCase()` 之后才查表。H5 同样先降级小写，否则整张表查不到，
 *     所有按钮都会被判成"无权限"。
 *  2) 隐藏按钮**不是**权限控制。后端每个写接口都会再次鉴权，H5 只负责
 *     「不给用户点出一个必 403 的按钮」，不能当作安全边界。
 */

import type { SessionUser } from "./api";

export const ALL_PERMISSIONS = [
  "customer.read",
  "customer.contact.read",
  "customer.create",
  "customer.update",
  "customer.contact.write",
  "customer.merge",
  "counterparty.read",
  "counterparty.manage",
  "order.create",
  "order.update",
  "order.event.post",
  "finance.read",
  "deposit.post",
  "finance.transfer",
  "finance.order.event.post",
  "policy.manage",
  "field-definition.manage",
  "audit.read",
  "pool.manage",
  "order-type.manage",
  "option-set.manage",
  "report.read",
  "report.export",
  "import.manage",
  "user.manage",
] as const;

export type Permission = (typeof ALL_PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<string, readonly string[]> = {
  admin: ALL_PERMISSIONS,
  operator: [
    "customer.read",
    "customer.create",
    "customer.update",
    "customer.contact.read",
    "customer.contact.write",
    "counterparty.read",
    "order.create",
    "order.update",
    "order.event.post",
    "finance.read",
    "report.read",
    "report.export",
  ],
  finance: [
    "finance.read",
    "deposit.post",
    "finance.transfer",
    "finance.order.event.post",
    "customer.read",
    "customer.contact.read",
    "counterparty.read",
    "audit.read",
    "report.read",
    "report.export",
  ],
  auditor: [
    "finance.read",
    "customer.read",
    "customer.contact.read",
    "counterparty.read",
    "policy.manage",
    "audit.read",
    "report.read",
    "report.export",
  ],
  viewer: ["finance.read", "report.read"],
  employee: ["order.create", "customer.read", "counterparty.read"],
};

/** 角色中文名。后端下发大写，这里两种写法都认。 */
export const ROLE_LABEL: Record<string, string> = {
  admin: "系统管理员",
  operator: "业务经办人",
  finance: "财务",
  auditor: "业务审核人",
  viewer: "经营查看人",
  employee: "普通员工",
};

export function roleLabel(role: string | null | undefined): string {
  if (!role) return "—";
  return ROLE_LABEL[role.toLowerCase()] ?? role;
}

/**
 * 是否拥有某权限点。
 * 传 `null`/`undefined` 视为「尚未拿到用户」，一律返回 false —— 宁可少显示一个按钮，
 * 也不要让员工点出一个保证 403 的入口。
 */
export function can(user: SessionUser | null | undefined, permission: Permission | string): boolean {
  if (!user?.role) return false;
  const granted = ROLE_PERMISSIONS[user.role.toLowerCase()];
  return Boolean(granted?.includes(permission));
}

export function canAny(user: SessionUser | null | undefined, permissions: string[]): boolean {
  return permissions.some((permission) => can(user, permission));
}
