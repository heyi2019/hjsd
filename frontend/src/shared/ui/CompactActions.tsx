import { Button } from "antd";
import type { ReactNode } from "react";
import { useContext } from "react";
import { ModalCancelContext } from "./BusinessActionModal";

/**
 * 紧凑弹窗的「操作条」。
 *
 * 背景：紧凑弹窗（size="compact"）原本把「确认」按钮直接放在表单里（footer={null}），
 * 于是只有一个主按钮贴左下、没有「取消」——既不像 macOS sheet（取消+确认成对、确认在右），
 * 也让用户只能靠 × / Esc 退出。本组件把确认按钮包起来，补一个右侧「取消」
 * （点击走 BusinessActionModal 下发的 onCancel），形成右对齐的 [取消 · 确认] 操作条，
 * 跨所有紧凑弹窗保持一致，无需每个调用点手动透传 onCancel。
 *
 * 两种用法：
 *  1) 表单内（footer={null}）：确认按钮在表单里，上下文自动提供 onCancel
 *     <CompactActions>
 *       <PermissionButton type="primary" htmlType="submit">确认锁定</PermissionButton>
 *     </CompactActions>
 *  2) 自定义 footer（footer 不在 ModalCancelContext 作用域内）：显式传 onCancel
 *     <BusinessActionModal ... footer={<CompactActions onCancel={onClose} divider={false}>...</CompactActions>} />
 *
 * onCancel 优先级：显式 prop > 上下文；两者皆无则回调为 undefined（按钮无副作用）。
 */
export function CompactActions({
  children,
  onCancel,
  divider = true,
}: { children: ReactNode; onCancel?: () => void; divider?: boolean }) {
  const ctxCancel = useContext(ModalCancelContext);
  const handleCancel = onCancel ?? ctxCancel;
  return (
    <div className={`compact-form-actions${divider ? "" : " no-divider"}`}>
      <Button onClick={handleCancel}>取消</Button>
      {children}
    </div>
  );
}
