/** 库存账号返点：买号返点关联买入订单，卖号返点关联实际售出订单。 */
import { Checkbox, Form, Input, Modal, Spin, message } from "antd";
import { useEffect, useMemo, useState } from "react";
import {
  accountsApi,
  rebatesApi,
  type Account,
  type AccountExecutionDetail,
} from "../shared/api/catalog";
import { normalizeError } from "../shared/api/client";
import { today } from "../shared/lib/format";
import { ErrorBanner, MoneyInput, PermissionButton } from "../shared/ui";

type RebateKind = "BUY" | "SELL";

const REBATE_KIND_LABEL: Record<RebateKind, string> = {
  BUY: "买号返点（对应回收）",
  SELL: "卖号返点（对应售出）",
};

function sourceOrder(detail: AccountExecutionDetail | null, kind: RebateKind) {
  if (kind === "BUY") {
    return detail?.orders.find((order) =>
      order.order_type === "HS" && order.events.some((event) => event.event_type === "BUY"),
    );
  }
  return detail?.orders.find((order) => order.events.some((event) => event.event_type === "SELL"));
}

function defaultBaseAmount(detail: AccountExecutionDetail | null, kind: RebateKind): string {
  const order = sourceOrder(detail, kind);
  const eventType = kind === "BUY" ? "BUY" : "SELL";
  return order?.events.find((event) => event.event_type === eventType)?.amount ?? "0";
}

export function InventoryRebateModal(props: {
  account: Account | null;
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const [detail, setDetail] = useState<AccountExecutionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [form] = Form.useForm();
  const open = Boolean(props.account);

  useEffect(() => {
    if (!open || !props.account) return;
    let cancelled = false;
    setLoading(true);
    void accountsApi.executionDetail(props.account.id)
      .then((value) => {
        if (cancelled) return;
        setDetail(value);
        setError(null);
        const firstKind: RebateKind | undefined = sourceOrder(value, "BUY") ? "BUY" : sourceOrder(value, "SELL") ? "SELL" : undefined;
        form.setFieldsValue({
          rebate_type: firstKind ? [firstKind] : [],
          base_amount: firstKind ? defaultBaseAmount(value, firstKind) : "0",
          collected_on: today(),
        });
      })
      .catch((cause) => {
        if (!cancelled) setError(normalizeError(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [form, open, props.account]);

  const availableKinds = useMemo(
    () => (["BUY", "SELL"] as RebateKind[]).filter((kind) => sourceOrder(detail, kind)),
    [detail],
  );

  const submit = async (values: { rebate_type?: RebateKind[]; base_amount?: string; rate?: string; collected_on?: string }) => {
    if (!props.account) return;
    const kind = values.rebate_type?.[0];
    const order = kind ? sourceOrder(detail, kind) : undefined;
    if (!kind || !order) return;
    try {
      await rebatesApi.create({
        source_order_id: order.order_id,
        base_amount: values.base_amount ?? "0",
        rate: values.rate ?? "0",
        collected_on: values.collected_on ?? today(),
        channel: kind === "BUY" ? "买号返点" : "卖号返点",
        note: REBATE_KIND_LABEL[kind],
      });
      message.success("返点已登记");
      form.resetFields();
      props.onClose();
      await props.onCreated();
    } catch (cause) {
      setError(normalizeError(cause));
    }
  };

  return (
    <Modal
      title="登记返点"
      open={open}
      destroyOnHidden
      onCancel={props.onClose}
      footer={
        <PermissionButton permission="order.event.post" type="primary" aria-label="确认登记" onClick={() => form.submit()}>
          确认登记
        </PermissionButton>
      }
    >
      <ErrorBanner error={error} />
      <p className="muted">{props.account?.inventory_no} · {props.account?.game_account ?? "未填写账号"}</p>
      {loading ? <Spin size="small" /> : (
        <Form form={form} layout="vertical" onFinish={submit}>
          <Form.Item
            name="rebate_type"
            label="返点类型"
            rules={[{ required: true, type: "array", min: 1, max: 1, message: "请选择一种返点类型" }]}
          >
            <Checkbox.Group
              onChange={(values) => {
                const kind = values.slice(-1)[0] as RebateKind | undefined;
                form.setFieldsValue({
                  rebate_type: kind ? [kind] : [],
                  base_amount: kind ? defaultBaseAmount(detail, kind) : "0",
                });
              }}
              options={(["BUY", "SELL"] as RebateKind[]).map((kind) => ({
                value: kind,
                label: REBATE_KIND_LABEL[kind],
                disabled: !availableKinds.includes(kind),
              }))}
            />
          </Form.Item>
          {!availableKinds.length ? <p className="muted">当前账号没有可关联的回收或分销来源订单</p> : null}
          <Form.Item
            name="base_amount"
            label="返点金额"
            extra="按此金额 × 返点比例计算预计返点"
            rules={[{ required: true, message: "请输入返点金额" }]}
          >
            <MoneyInput />
          </Form.Item>
          <Form.Item name="rate" label="返点比例" initialValue="0">
            <Input inputMode="decimal" suffix="%" placeholder="例如 5" />
          </Form.Item>
          <Form.Item name="collected_on" label="返点日期" rules={[{ required: true, message: "请输入返点日期" }]}>
            <Input placeholder="YYYY-MM-DD" />
          </Form.Item>
        </Form>
      )}
    </Modal>
  );
}
