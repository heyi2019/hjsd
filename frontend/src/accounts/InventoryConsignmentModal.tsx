/** 库存账号寄售：选择已维护的寄售平台，并为当前账号登记代挂业务记录。 */
import { Checkbox, Form, Modal, message } from "antd";
import { useEffect, useState } from "react";
import {
  counterpartiesApi,
  ordersApi,
  type Account,
  type Counterparty,
} from "../shared/api/catalog";
import { normalizeError } from "../shared/api/client";
import { today } from "../shared/lib/format";
import { ErrorBanner, PermissionButton } from "../shared/ui";
import { CfgItem, FieldConfigContext, useOrderFormConfig } from "../orders/ConfigurableField";

export function InventoryConsignmentModal(props: {
  account: Account | null;
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const [platforms, setPlatforms] = useState<Counterparty[]>([]);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();
  const open = Boolean(props.account);
  const { config } = useOrderFormConfig(open ? "CONSIGN" : undefined);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void counterpartiesApi.list({ type: "PLATFORM", status: "ACTIVE" })
      .then((items) => {
        if (cancelled) return;
        setPlatforms(items);
        setError(null);
      })
      .catch((cause) => {
        if (!cancelled) setError(normalizeError(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const submit = async (values: { platform_ids?: number[] }) => {
    if (!props.account) return;
    const selected = platforms.filter((platform) => values.platform_ids?.includes(platform.id));
    setSubmitting(true);
    try {
      await ordersApi.create({
        order_type: "DG",
        trade_date: today(),
        account_id: props.account.id,
        note: `寄售平台：${selected.map((platform) => platform.display_name).join("、")}`,
        counterparty_roles: selected.map((platform) => ({
          counterparty_id: platform.id,
          role: "PLATFORM",
        })),
      });
      message.success("寄售已登记，账号仍保持在库");
      form.resetFields();
      props.onClose();
      await props.onCreated();
    } catch (cause) {
      setError(normalizeError(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="登记寄售"
      open={open}
      destroyOnHidden
      onCancel={props.onClose}
      footer={
        <PermissionButton permission="order.create" type="primary" aria-label="确认寄售" loading={submitting} onClick={() => form.submit()}>
          确认寄售
        </PermissionButton>
      }
    >
      <ErrorBanner error={error} />
      <p className="muted">{props.account?.game_account ?? "未填写账号"}</p>
      <FieldConfigContext.Provider value={config}>
        <Form form={form} layout="vertical" onFinish={submit}>
          <CfgItem
            name="platform_ids"
            label="寄售平台"
            rules={[{ required: true, type: "array", min: 1, message: "请至少勾选一个寄售平台" }]}
          >
            {platforms.length ? (
              <Checkbox.Group
                options={platforms.map((platform) => ({
                  value: platform.id,
                  label: platform.display_name,
                }))}
              />
            ) : (
              <span className="muted">暂无可用寄售平台，请先在合作方中维护平台</span>
            )}
          </CfgItem>
        </Form>
      </FieldConfigContext.Provider>
    </Modal>
  );
}
