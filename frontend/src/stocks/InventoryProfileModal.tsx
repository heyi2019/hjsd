import { appMessage } from "../shared/ui/appFeedback";
import { Input, Space, Upload } from "antd";
import type { UploadFile } from "antd/es/upload/interface";
import { useEffect, useState } from "react";
import { stocksApi } from "../shared/api/stocks.api";
import type { Account } from "../shared/api/types/accounts";
import { BusinessActionModal, InlineError, Select } from "../shared/ui";
import "./InventoryProfileModal.css";

export type InventoryProfileTarget = {
  account: Account;
  mode: "description" | "images" | "all";
  /** 订单台账入口明确指定的业务订单；库存入口回退使用账号来源订单。 */
  orderId?: number;
};

function readImageData(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

function ProfileContext({ account }: { account: Account }) {
  return (
    <div className="inventory-profile-context" aria-label="账号上下文">
      <div className="inventory-profile-context__item"><span>订单编号</span><strong>{account.source_order_no ?? "-"}</strong></div>
      <div className="inventory-profile-context__item"><span>游戏类型</span><strong>{account.game_type ?? "-"}</strong></div>
      <div className="inventory-profile-context__item"><span>游戏账号</span><strong>{account.game_account ?? "-"}</strong></div>
    </div>
  );
}

export function InventoryProfileModal({
  target,
  onClose,
  onSaved,
  onError,
  onOperation,
}: {
  target: InventoryProfileTarget | null;
  onClose: () => void;
  onSaved: (account: Account) => void;
  onError: (error: unknown) => void;
  onOperation?: (operationType: "IMAGE" | "DESCRIPTION") => void | Promise<void>;
}) {
  const [form, setForm] = useState({
    gameAccount: "",
    campAccount: "",
    gameType: "",
    gamePassword: "",
    channelRegion: "",
    boundPhone: "",
    platform: "",
    hasSecondary: undefined as boolean | undefined,
    description: "",
    note: "",
  });
  const [images, setImages] = useState<UploadFile[]>([]);
  const [saving, setSaving] = useState(false);
  const [validationError, setValidationError] = useState<{ message: string } | null>(null);

  useEffect(() => {
    if (!target) return;
    const { account } = target;
    setForm({
      gameAccount: account.game_account ?? "",
      campAccount: account.camp_account ?? "",
      gameType: account.game_type ?? "",
      gamePassword: account.game_password ?? "",
      channelRegion: account.channel_region ?? "",
      boundPhone: account.bound_phone ?? "",
      platform: account.platform ?? "",
      hasSecondary: account.has_secondary ?? undefined,
      description: account.account_description ?? "",
      note: account.note ?? "",
    });
    setImages((account.account_images ?? []).slice(0, 9).map((url, index) => ({
      uid: `${account.id}-${index}`,
      name: `作图${index + 1}`,
      status: "done",
      url,
    })));
    setValidationError(null);
  }, [target]);

  async function imageValues(): Promise<string[]> {
    return (await Promise.all(images.slice(0, 9).map(async (file) => {
      if (file.url) return file.url;
      return file.originFileObj ? readImageData(file.originFileObj) : null;
    }))).filter((item): item is string => Boolean(item));
  }

  async function save() {
    if (!target) return;
    setValidationError(null);
    setSaving(true);
    try {
      const imagePayload = target.mode === "description" ? null : await imageValues();
      if (target.mode === "images" && !imagePayload?.length) {
        setValidationError({ message: "请至少添加一张图片" });
        return;
      }
      const payload = target.mode === "description"
        ? { account_description: form.description }
        : target.mode === "images" ? { account_images: imagePayload ?? [] } : {
            game_account: form.gameAccount,
            camp_account: form.campAccount,
            game_type: form.gameType,
            game_password: form.gamePassword,
            channel_region: form.channelRegion,
            bound_phone: form.boundPhone,
            platform: form.platform,
            has_secondary: form.hasSecondary,
            account_description: form.description,
            account_images: imagePayload ?? [],
            note: form.note,
          };
      const updated = await stocksApi.updateProfile(target.account.id, payload);
      if (onOperation && (target.mode === "description" || target.mode === "images")) {
        await onOperation(target.mode === "images" ? "IMAGE" : "DESCRIPTION");
      }
      onSaved(updated);
      onClose();
      appMessage.success("账号资料已保存");
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <BusinessActionModal size="compact"
      open={Boolean(target)}
      title={target?.mode === "images" ? "作图" : target?.mode === "description" ? "描述" : "编辑账号资料"}
      okText="保存"
      cancelText="取消"
      confirmLoading={saving}
      onCancel={onClose}
      onOk={() => void save()}
    >
      <InlineError error={validationError} />
      {target?.mode === "images" ? (
        <Space className="inventory-profile-description-editor" direction="vertical" size="middle">
          <ProfileContext account={target.account} />
          <Upload
            listType="picture-card"
            accept="image/*"
            maxCount={9}
            fileList={images}
            beforeUpload={() => false}
            onChange={({ fileList }) => setImages(fileList.slice(0, 9))}
          >
            <span aria-hidden="true">＋</span>
            <div>添加图片</div>
          </Upload>
        </Space>
      ) : target?.mode === "description" ? (
        <Space className="inventory-profile-description-editor" direction="vertical" size="middle">
          <ProfileContext account={target.account} />
          <Input.TextArea
            rows={8}
            maxLength={400}
            showCount
            value={form.description}
            placeholder="补充账号等级、资源、限制等信息"
            onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
          />
        </Space>
      ) : (
        <Space className="inventory-profile-editor" direction="vertical" size="middle">
          <Input aria-label="游戏账号/产品" placeholder="游戏账号/产品" value={form.gameAccount} onChange={(event) => setForm((current) => ({ ...current, gameAccount: event.target.value }))} />
          <Input aria-label="营地账号" placeholder="营地账号" value={form.campAccount} onChange={(event) => setForm((current) => ({ ...current, campAccount: event.target.value }))} />
          <Input aria-label="游戏/产品类型" placeholder="游戏/产品类型" value={form.gameType} onChange={(event) => setForm((current) => ({ ...current, gameType: event.target.value }))} />
          <Input.Password aria-label="账号密码" placeholder="账号密码" value={form.gamePassword} onChange={(event) => setForm((current) => ({ ...current, gamePassword: event.target.value }))} />
          <Input aria-label="渠道 / 区服" placeholder="渠道 / 区服" value={form.channelRegion} onChange={(event) => setForm((current) => ({ ...current, channelRegion: event.target.value }))} />
          <Input aria-label="绑定手机号" placeholder="绑定手机号" value={form.boundPhone} onChange={(event) => setForm((current) => ({ ...current, boundPhone: event.target.value }))} />
          <Input aria-label="平台" placeholder="平台" value={form.platform} onChange={(event) => setForm((current) => ({ ...current, platform: event.target.value }))} />
          <Select allowClear value={form.hasSecondary == null ? undefined : form.hasSecondary ? "有" : "无"} placeholder="有无二次" options={[{ value: "有", label: "有二次" }, { value: "无", label: "无二次" }]} onChange={(value) => setForm((current) => ({ ...current, hasSecondary: value == null ? undefined : value === "有" }))} />
          <Input.TextArea rows={4} maxLength={2000} showCount value={form.description} placeholder="描述" onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} />
          <Upload listType="picture-card" accept="image/*" maxCount={9} fileList={images} beforeUpload={() => false} onChange={({ fileList }) => setImages(fileList.slice(0, 9))}>
            <span aria-hidden="true">＋</span>
            <div>添加图片</div>
          </Upload>
          <Input.TextArea rows={3} value={form.note} placeholder="账号备注" onChange={(event) => setForm((current) => ({ ...current, note: event.target.value }))} />
        </Space>
      )}
    </BusinessActionModal>
  );
}
