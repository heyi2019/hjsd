import { appMessage } from "../shared/ui/appFeedback";
import { configurableLabel } from "../shared/lib/optionSets";
import { Form, Input, Radio, Space, Spin, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import { stocksApi,
  rebatesApi,
  employeesApi,
  type Account,
  type AccountExecutionDetail,
  type EmployeeOption,
  type Rebate, } from "../shared/api/catalog";
import { normalizeError } from "../shared/api/client";
import { today } from "../shared/lib/format";
import { moneyRules, percentRules } from "../shared/lib/validators";
import { BusinessActionModal, BusinessForm, ConfirmButton, DataTable, ErrorBanner, MoneyInput, MoneyText, PermissionButton } from "../shared/ui";
import { CfgItem, CustomFieldSection, FieldConfigContext, useOrderFormConfig } from "../orders/ConfigurableField";
import { ResponsibleEmployeeSelect } from "../orders/ResponsibleEmployeeSelect";
import { InventoryAccountSummary } from "./InventoryAccountSummary";
import "./InventoryRebateModal.css";

type RebateKind = "BUY" | "SELL";

const REBATE_KIND_LABEL: Record<RebateKind, string> = {
  BUY: "买号返点（对应回收/提号）",
  SELL: "卖号返点（对应售出）",
};

function sourceOrder(detail: AccountExecutionDetail | null, kind: RebateKind) {
  if (kind === "BUY") {
    return detail?.orders.find((order) =>
      ["HS", "TH"].includes(order.order_type),
    );
  }
  const sellOrder = detail?.orders.find((order) => order.events.some((event) =>
    event.event_type === "SELL",
  ));
  return sellOrder ?? detail?.orders.find((order) => ["HS", "TH", "DG"].includes(order.order_type));
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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [rebates, setRebates] = useState<Rebate[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [editTarget, setEditTarget] = useState<Rebate | null>(null);
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();
  const open = Boolean(props.account);
  const { config } = useOrderFormConfig(open ? "INVREBATE" : undefined);

  useEffect(() => {
    if (!open || !props.account) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void stocksApi.executionDetail(props.account.id)
      .then(async (value) => {
        if (cancelled) return;
        setDetail(value);
        const orderIds = [...new Set(value.orders.map((order) => order.order_id))];
        const rebateLists = await Promise.all(orderIds.map((orderId) => rebatesApi.list({ source_order_id: orderId })));
        const uniqueRebates = new Map<number, Rebate>();
        for (const rebate of rebateLists.flat()) uniqueRebates.set(rebate.id, rebate);
        setRebates([...uniqueRebates.values()]);
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

  useEffect(() => {
    if (!open) return;
    void employeesApi.list()
      .then(setEmployees)
      .catch((cause) => setError(normalizeError(cause)));
  }, [open]);

  const availableKinds = useMemo(
    () => (["BUY", "SELL"] as RebateKind[]).filter((kind) => sourceOrder(detail, kind)),
    [detail],
  );

  const submit = async (values: { rebate_type?: RebateKind; base_amount?: string; rate?: string; collected_on?: string; operator_user_ids?: number[]; form_extra?: Record<string, unknown> }) => {
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
        operator_user_ids: values.operator_user_ids,
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

  const submitEdit = async (values: { base_amount?: string; rate?: string; collected_on?: string; note?: string; operator_user_ids?: number[] }) => {
    if (!editTarget) return;
    try {
      const updated = await rebatesApi.update(editTarget.id, {
        base_amount: values.base_amount,
        rate: values.rate,
        collected_on: values.collected_on,
        note: values.note || null,
        operator_user_ids: values.operator_user_ids,
      });
      setRebates((current) => current.map((item) => item.id === updated.id ? updated : item));
      setEditTarget(null);
      editForm.resetFields();
      appMessage.success("返点明细已更新");
    } catch (cause) {
      setError(normalizeError(cause));
    }
  };

  return (
    <BusinessActionModal
      title="登记返点"
      open={open}
      destroyOnHidden
      onCancel={props.onClose}
      width={1200}
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
          <BusinessForm
            scope="INVREBATE"
            form={form}
            className="inventory-rebate-form ui-form-spaced"
            layout="horizontal"
            labelAlign="left"
            labelCol={{ flex: "120px" }}
            wrapperCol={{ flex: "auto" }}
            onFinish={submit}
          >
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
            <div className="rebate-core-fields">
              <CfgItem
                name="base_amount"
                label="返点金额"
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
              <ResponsibleEmployeeSelect name="operator_user_ids" label="操作人" employees={employees} />
            </div>
            <CustomFieldSection testIdSuffix="inventory-rebate" />
          </BusinessForm>
        </FieldConfigContext.Provider>
      )}
      {!loading ? (
        <section className="inventory-rebate-details ui-stack" aria-label="返点明细">
          <Typography.Text strong>返点明细</Typography.Text>
          <DataTable<Rebate>
            rows={rebates}
            columns={[
              { title: "返点单号", dataIndex: "rebate_no" },
              { title: "类型", render: (_value, row) => row.rebate_type === "BUY" ? "买号返点" : "卖号返点" },
              { title: "金额", dataIndex: "base_amount", align: "right", render: (value: string) => <MoneyText value={value} /> },
              { title: "比例", dataIndex: "rate", render: (value: string) => `${value}%` },
              { title: "返点日期", dataIndex: "collected_on" },
              {
                title: "操作人",
                render: (_value: unknown, row: Rebate) => row.operator_user_ids?.map((id) => employees.find((employee) => employee.id === id)?.display_name).filter(Boolean).join("、") || row.operator || "-",
              },
              {
                title: "操作",
                render: (_value, row) => (
                  <Space size={2}>
                    <PermissionButton
                      permission="order.event.post"
                      size="small"
                      onClick={() => {
                        editForm.setFieldsValue({
                          base_amount: row.base_amount,
                          rate: row.rate,
                          collected_on: row.collected_on,
                          note: row.note ?? "",
                          operator_user_ids: row.operator_user_ids ?? undefined,
                        });
                        setEditTarget(row);
                      }}
                    >编辑</PermissionButton>
                    <ConfirmButton
                      permission="order.event.post"
                      size="small"
                      danger
                      title="删除返点明细"
                      description="删除后该返点记录将不再保留，确定删除吗？"
                      okText="删除"
                      onConfirm={async () => {
                        await rebatesApi.remove(row.id);
                        setRebates((current) => current.filter((item) => item.id !== row.id));
                        appMessage.success("返点明细已删除");
                      }}
                    >删除</ConfirmButton>
                  </Space>
                ),
              },
            ]}
            page={1}
            pageSize={Math.max(rebates.length, 5)}
            total={rebates.length}
            onPageChange={() => undefined}
            pagination={false}
            emptyText="暂无返点明细"
          />
        </section>
      ) : null}
      <BusinessActionModal
        title={editTarget ? `编辑返点 · ${editTarget.rebate_no}` : "编辑返点"}
        open={Boolean(editTarget)}
        onCancel={() => setEditTarget(null)}
        footer={null}
      >
        <FieldConfigContext.Provider value={config}>
          <BusinessForm scope="INVREBATE" form={editForm} onFinish={submitEdit}>
            <div className="rebate-core-fields">
              <CfgItem name="base_amount" label="返点金额" rules={[{ required: true, message: "请输入返点金额" }, ...moneyRules("返点金额")]}> <MoneyInput /></CfgItem>
              <CfgItem name="rate" label="返点比例" rules={percentRules("返点比例")}><Input suffix="%" /></CfgItem>
              <CfgItem name="collected_on" label="返点日期" rules={[{ required: true, message: "请输入返点日期" }]}><Input /></CfgItem>
              <ResponsibleEmployeeSelect name="operator_user_ids" label="操作人" employees={employees} />
            </div>
            <CfgItem name="note" label="备注"><Input.TextArea rows={3} /></CfgItem>
            <PermissionButton permission="order.event.post" type="primary" htmlType="submit">保存</PermissionButton>
          </BusinessForm>
        </FieldConfigContext.Provider>
      </BusinessActionModal>
    </BusinessActionModal>
  );
}
