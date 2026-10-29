import { appMessage, appModal } from "../shared/ui/appFeedback";
/** 库存账号返点：创建业务订单后即可选择买号或卖号返点，实际流水只用于带出金额。 */
import { configurableLabel } from "../shared/lib/optionSets";
import { Form, Input, Modal, Radio, Spin } from "antd";
import { useEffect, useMemo, useState } from "react";
import {
  stocksApi,
  rebatesApi,
  type Account,
  type AccountExecutionDetail,
} from "../shared/api/catalog";
import { normalizeError } from "../shared/api/client";
import { today } from "../shared/lib/format";
import { moneyRules, percentRules } from "../shared/lib/validators";
import { ErrorBanner, MoneyInput, PermissionButton } from "../shared/ui";
import { CfgItem, CustomFieldSection, FieldConfigContext, useOrderFormConfig } from "../orders/ConfigurableField";
import { InventoryAccountSummary } from "./InventoryAccountSummary";
import "./InventoryRebateModal.css";

type RebateKind = "BUY" | "SELL";

const REBATE_KIND_LABEL: Record<RebateKind, string> = {
  BUY: "买号返点（对应回收）",
  SELL: "卖号返点（对应售出）",
};

function sourceOrder(detail: AccountExecutionDetail | null, kind: RebateKind) {
  if (kind === "BUY") {
    return detail?.orders.find((order) =>
      ["HS", "TH", "DFQ"].includes(order.order_type),
    );
  }
  const sellOrder = detail?.orders.find((order) => order.events.some((event) =>
    event.event_type === "SELL" || (order.order_type === "DFQ" && event.event_type === "PAYMENT"),
  ));
  return sellOrder ?? detail?.orders.find((order) => ["HS", "TH", "DG", "DFQ"].includes(order.order_type));
}

function defaultBaseAmount(detail: AccountExecutionDetail | null, kind: RebateKind): string {
  const order = sourceOrder(detail, kind);
  const eventType = kind === "BUY" ? "BUY" : order?.order_type === "DFQ" ? "PAYMENT" : "SELL";
  return order?.events.find((event) => event.event_type === eventType)?.amount ?? "0";
}

export function InventoryRebateModal(props: {
  account: Account | null;
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const [detail, setDetail] = useState<AccountExecutionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [form] = Form.useForm();
  const open = Boolean(props.account);
  const { config } = useOrderFormConfig(open ? "INVREBATE" : undefined);

  useEffect(() => {
    if (!open || !props.account) return;
    let cancelled = false;
    setLoading(true);
    void stocksApi.executionDetail(props.account.id)
      .then((value) => {
        if (cancelled) return;
        setDetail(value);
        setError(null);
        const firstKind: RebateKind | undefined = sourceOrder(value, "BUY") ? "BUY" : sourceOrder(value, "SELL") ? "SELL" : undefined;
        form.setFieldsValue({
          rebate_type: firstKind,
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

  const submit = async (values: { rebate_type?: RebateKind; base_amount?: string; rate?: string; collected_on?: string; form_extra?: Record<string, unknown> }) => {
    if (!props.account) return;
    const kind = values.rebate_type;
    const order = kind ? sourceOrder(detail, kind) : undefined;
    if (!kind || !order) return;
    setSubmitting(true);
    try {
      await rebatesApi.create({
        source_order_id: order.order_id,
        rebate_type: kind,
        base_amount: values.base_amount ?? "0",
        rate: values.rate ?? "0",
        collected_on: values.collected_on ?? today(),
        channel: kind === "BUY" ? "买号返点" : "卖号返点",
        note: REBATE_KIND_LABEL[kind],
        form_extra: values.form_extra,
      });
      appMessage.success("返点已登记");
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
      title="登记返点"
      open={open}
      destroyOnHidden
      onCancel={props.onClose}
      footer={
        <PermissionButton permission="order.event.post" type="primary" aria-label="确认登记" loading={submitting} onClick={() => form.submit()}>
          确认登记
        </PermissionButton>
      }
    >
      <ErrorBanner error={error} />
      <InventoryAccountSummary account={props.account} />
      {loading ? <Spin size="small" /> : (
        <FieldConfigContext.Provider value={config}>
          <Form
            form={form}
            className="inventory-rebate-form"
            layout="horizontal"
            labelAlign="left"
            labelCol={{ flex: "120px" }}
            wrapperCol={{ flex: "auto" }}
            onFinish={submit}
          >
            <p className="muted">关联业务订单创建后即可登记返点；后续买入、卖出或收款用于记录实际业务流水。</p>
            <CfgItem
              name="rebate_type"
              label="返点类型"
              rules={[{ required: true, message: "请选择一种返点类型" }]}
            >
              <Radio.Group
                onChange={(event) => {
                  const kind = event.target.value as RebateKind;
                  form.setFieldsValue({
                    rebate_type: kind,
                    base_amount: defaultBaseAmount(detail, kind),
                  });
                }}
              >
                {(["BUY", "SELL"] as RebateKind[]).map((kind) => <Radio key={kind} value={kind} disabled={!availableKinds.includes(kind)}>{configurableLabel("REBATE_TYPE", kind, REBATE_KIND_LABEL)}</Radio>)}
              </Radio.Group>
            </CfgItem>
            {!availableKinds.length ? <p className="muted">当前账号没有可关联的业务订单</p> : null}
            <CfgItem
              name="base_amount"
              label="返点金额"
              extra="按此金额 × 返点比例计算预计返点"
              rules={[{ required: true, message: "请输入返点金额" }, ...moneyRules("返点金额")]}
            >
              <MoneyInput placeholder="请输入返点金额" />
            </CfgItem>
            <CfgItem name="rate" label="返点比例" initialValue="0" rules={[...percentRules("返点比例")]}>
              <Input inputMode="decimal" suffix="%" placeholder="例如 5" />
            </CfgItem>
            <CfgItem name="collected_on" label="返点日期" rules={[{ required: true, message: "请输入返点日期" }]}>
              <Input placeholder="YYYY-MM-DD" />
            </CfgItem>
            <CustomFieldSection testIdSuffix="inventory-rebate" />
          </Form>
        </FieldConfigContext.Provider>
      )}
    </Modal>
  );
}
