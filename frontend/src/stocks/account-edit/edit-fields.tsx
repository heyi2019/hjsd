import { Input, Space, Upload } from "antd";
import type { UploadFile } from "antd/es/upload/interface";
import type { Account } from "../../shared/api/types/accounts";
import { Select } from "../../shared/ui";

function readImageData(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

function imageFileList(values: string[] | null | undefined, prefix: string): UploadFile[] {
  return (values ?? []).map((url, index) => ({
    uid: `${prefix}-${index}`,
    name: `${prefix}${index + 1}`,
    status: "done",
    url,
  }));
}

function ImageField({
  label,
  values,
  prefix,
  maxCount,
  onChange,
}: {
  label: string;
  values?: string[] | null;
  prefix: string;
  maxCount: number;
  onChange: (values: string[]) => void;
}) {
  return (
    <label className="inventory-edit-more__images">
      <span>{label}</span>
      <Upload
        listType="picture-card"
        accept="image/*"
        maxCount={maxCount}
        fileList={imageFileList(values, prefix)}
        beforeUpload={() => false}
        onChange={({ fileList }) => {
          void Promise.all(fileList.slice(0, maxCount).map(async (file) => {
            if (file.url) return file.url;
            return file.originFileObj ? readImageData(file.originFileObj) : null;
          })).then((next) => onChange(next.filter((item): item is string => Boolean(item))));
        }}
      >
        <span aria-hidden="true">＋</span>
      </Upload>
    </label>
  );
}

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
        <label><span>营地账号</span><Input aria-label="编辑营地账号" value={editing.camp_account ?? ""} onChange={(event) => onEdit?.({ ...editing, camp_account: event.target.value })} /></label>
        <label><span>账号密码</span><Input.Password aria-label="编辑账号密码" value={editing.game_password ?? ""} onChange={(event) => onEdit?.({ ...editing, game_password: event.target.value })} /></label>
        <label><span>渠道 / 区服</span><Input aria-label="编辑渠道区服" value={editing.channel_region ?? ""} onChange={(event) => onEdit?.({ ...editing, channel_region: event.target.value })} /></label>
        <label><span>绑定手机号</span><Input aria-label="编辑绑定手机号" value={editing.bound_phone ?? ""} onChange={(event) => onEdit?.({ ...editing, bound_phone: event.target.value })} /></label>
        <label><span>平台</span><Input aria-label="编辑平台" value={editing.platform ?? ""} onChange={(event) => onEdit?.({ ...editing, platform: event.target.value })} /></label>
        <label><span>有无二次</span><Select aria-label="编辑有无二次" allowClear value={editing.has_secondary == null ? undefined : editing.has_secondary ? "有" : "无"} options={[{ value: "有", label: "有" }, { value: "无", label: "无" }]} onChange={(value) => onEdit?.({ ...editing, has_secondary: value == null ? null : value === "有" })} /></label>
        <label><span>钱包实名</span><Input aria-label="编辑钱包实名" value={editing.wallet_realname ?? ""} onChange={(event) => onEdit?.({ ...editing, wallet_realname: event.target.value })} /></label>
        <label className="inventory-edit-more__note"><span>备注</span><Input aria-label="编辑备注" value={editing.note ?? ""} onChange={(event) => onEdit?.({ ...editing, note: event.target.value })} /></label>
        <label className="inventory-edit-more__note"><span>账号描述</span><Input.TextArea aria-label="编辑账号描述" rows={3} value={editing.account_description ?? ""} onChange={(event) => onEdit?.({ ...editing, account_description: event.target.value })} /></label>
        <Space direction="vertical" size="small" className="inventory-edit-more__images-group">
          <ImageField label="二次图片" values={editing.secondary_images} prefix="二次图片" maxCount={3} onChange={(values) => onEdit?.({ ...editing, secondary_images: values })} />
          <ImageField label="钱包实名图片" values={editing.wallet_realname_images} prefix="钱包实名图片" maxCount={3} onChange={(values) => onEdit?.({ ...editing, wallet_realname_images: values })} />
          <ImageField label="作图" values={editing.account_images} prefix="作图" maxCount={9} onChange={(values) => onEdit?.({ ...editing, account_images: values })} />
        </Space>
      </div>
    </details>
  );
}
