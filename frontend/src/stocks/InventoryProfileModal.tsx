import { appMessage } from "../shared/ui/appFeedback";
import { Input, Space, Upload } from "antd";
import type { UploadFile } from "antd/es/upload/interface";
import { useEffect, useState } from "react";
import { stocksApi } from "../shared/api/stocks.api";
import type { Account } from "../shared/api/types/accounts";
import { BusinessActionModal, InlineError } from "../shared/ui";
import "./InventoryProfileModal.css";

export type InventoryProfileTarget = {
  account: Account;
  mode: "description" | "images";
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
  const [description, setDescription] = useState("");
  const [images, setImages] = useState<UploadFile[]>([]);
  const [saving, setSaving] = useState(false);
  const [validationError, setValidationError] = useState<{ message: string } | null>(null);

  useEffect(() => {
    if (!target) return;
    const { account } = target;
    setDescription(account.account_description ?? "");
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
      const imagePayload = target.mode === "images" ? await imageValues() : null;
      if (target.mode === "images" && !imagePayload?.length) {
        setValidationError({ message: "请至少添加一张图片" });
        return;
      }
      const payload = target.mode === "description"
        ? { account_description: description }
        : { account_images: imagePayload ?? [] };
      const updated = await stocksApi.updateProfile(target.account.id, payload);
      if (onOperation) {
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

  if (!target) return null;

  return (
    <BusinessActionModal size="compact"
      open={Boolean(target)}
      title={target.mode === "images" ? "作图" : "描述"}
      okText="保存"
      cancelText="取消"
      confirmLoading={saving}
      onCancel={onClose}
      onOk={() => void save()}
    >
      <InlineError error={validationError} />
      {target.mode === "images" ? (
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
      ) : (
        <Space className="inventory-profile-description-editor" direction="vertical" size="middle">
          <ProfileContext account={target.account} />
          <Input.TextArea
            rows={8}
            maxLength={400}
            showCount
            value={description}
            placeholder="补充账号等级、资源、限制等信息"
            onChange={(event) => setDescription(event.target.value)}
          />
        </Space>
      )}
    </BusinessActionModal>
  );
}
