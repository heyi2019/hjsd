import { Input } from "antd";
import type { Account } from "../shared/api/types/accounts";
import { Select } from "../shared/ui";

/** 编辑态专属：折叠区里的账号补充资料表单。只读态这些字段以 Descriptions 展示（见 Profile 板块）。 */
export function OrderDetailEditFields({
  editing,
  onEdit,
}: {
  editing: Account;
  onEdit?: (account: Account) => void;
}) {
  return (
    <details className="inventory-edit-more">
      <summary>更多账号资料</summary>
      <div className="inventory-edit-more__fields">
        <label><span>账号密码</span><Input.Password aria-label="编辑账号密码" value={editing.game_password ?? ""} onChange={(event) => onEdit?.({ ...editing, game_password: event.target.value })} /></label>
        <label><span>渠道 / 区服</span><Input aria-label="编辑渠道区服" value={editing.channel_region ?? ""} onChange={(event) => onEdit?.({ ...editing, channel_region: event.target.value })} /></label>
        <label><span>绑定手机号</span><Input aria-label="编辑绑定手机号" value={editing.bound_phone ?? ""} onChange={(event) => onEdit?.({ ...editing, bound_phone: event.target.value })} /></label>
        <label><span>有无二次</span><Select aria-label="编辑有无二次" allowClear value={editing.has_secondary == null ? undefined : editing.has_secondary ? "有" : "无"} options={[{ value: "有", label: "有" }, { value: "无", label: "无" }]} onChange={(value) => onEdit?.({ ...editing, has_secondary: value == null ? null : value === "有" })} /></label>
        <label className="inventory-edit-more__note"><span>备注</span><Input aria-label="编辑备注" value={editing.note ?? ""} onChange={(event) => onEdit?.({ ...editing, note: event.target.value })} /></label>
      </div>
    </details>
  );
}
