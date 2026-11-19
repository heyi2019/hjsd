import { appMessage } from "../../../shared/ui/appFeedback";
import { configurableLabel } from "../../../shared/lib/optionSets";
import { Form, Input, Radio, Space, Spin, Typography } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { employeesApi } from "../../../shared/api/org.api";
import { ordersApi } from "../../../shared/api/orders.api";
import { rebatesApi } from "../../../shared/api/rebates.api";
import type { AccountExecutionDetail } from "../../../shared/api/types/account-execution";
import type { Account } from "../../../shared/api/types/accounts";
import type { Rebate } from "../../../shared/api/types/finance";
import type { EmployeeOption } from "../../../shared/api/types/org";
import { normalizeError } from "../../../shared/api/client";
import { today } from "../../../shared/lib/format";
import { moneyRules } from "../../../shared/lib/validators";
import { BusinessActionModal, BusinessRegistrationForm, DateField, ErrorBanner, MoneyInput, MoneyText, PermissionButton, dateValueFromEvent, dateValueProps } from "../../../shared/ui";
import { CfgItem, CustomFieldSection, FieldConfigContext, useOrderFormConfig } from "../../ConfigurableField";
import { ResponsibleEmployeeSelect } from "../../ResponsibleEmployeeSelect";
import { InventoryAccountSummary } from "../InventoryAccountSummary";
import "./rebate-modal.css";

type RebateKind = "BUY" | "SELL";

const REBATE_KIND_LABEL: Record<RebateKind, string> = {
  BUY: "买号返点（对应回收/提号）",
  SELL: "卖号返点（对应售出）",
};

function sourceOrder(detail: AccountExecutionDetail | null, sourceOrderId: number | null | undefined, kind: RebateKind) {
  const order = detail?.orders.find((item) => item.order_id === sourceOrderId);
  if (!order) return undefined;
  if (kind === "BUY") return ["HS", "TH"].includes(order.order_type) ? order : undefined;
  return order.events.some((event) => event.event_type === "SELL") ? order : undefined;
}

export function InventoryRebateModal(props: {
  account: Account | null;
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const [detail, setDetail] = useState<AccountExecutionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submitInFlight = useRef(false);
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
    const sourceOrderId = props.account.source_order_id;
    if (sourceOrderId == null) {
      setError({ message: "当前账号没有绑定来源订单，无法登记返点" });
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void ordersApi.executionDetail(sourceOrderId)
      .then(async (value) => {
        if (cancelled) return;
        setDetail(value);
        setRebates(await rebatesApi.list({ source_order_id: sourceOrderId }));
        const firstKind: RebateKind | undefined = sourceOrder(value, sourceOrderId, "BUY") ? "BUY" : sourceOrder(value, sourceOrderId, "SELL") ? "SELL" : undefined;
        form.setFieldsValue({
          rebate_type: firstKind,
          amount: undefined,
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
    () => (["BUY", "SELL"] as RebateKind[]).filter((kind) => sourceOrder(detail, props.account?.source_order_id, kind)),
    [detail, props.account?.source_order_id],
  );

  const submit = async (values: { rebate_type?: RebateKind; amount?: string; collected_on?: string; operator_user_ids?: number[]; form_extra?: Record<string, unknown> }) => {
    if (!props.account) return;
    const kind = values.rebate_type;
    const order = kind ? sourceOrder(detail, props.account.source_order_id, kind) : undefined;
    if (!kind || !order || submitInFlight.current) return;
    submitInFlight.current = true;
    setSubmitting(true);
    try {
      await rebatesApi.create({
        source_order_id: order.order_id,
        rebate_type: kind,
        amount: values.amount!,
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
      submitInFlight.current = false;
      setSubmitting(false);
    }
  };

  const submitEdit = async (values: { amount?: string; collected_on?: string; note?: string; operator_user_ids?: number[] }) => {
    if (!editTarget) return;
    try {
      const updated = await rebatesApi.update(editTarget.id, {
        amount: values.amount,
        collected_on: values.collected_on,
        note: values.note || null,
        operator_user_ids: values.operator_user_ids,
      });
      setRebates((current) => current.map((item) => item.id === updated.id ? updated : item));
      setEditTarget(null);
      editForm.resetFields();
      appMessage.success("返点明细已更新");
      // 返点是收入"其中项"，编辑会改变订单利润/分润：必须通知上层刷新订单详情与统计（与登记/删除同口径）。
      await props.onCreated();
    } catch (cause) {
      setError(normalizeError(cause));
    }
  };

  return (
    <>
    <BusinessActionModal
      title="登记返点"
      fieldCount={3 + Object.keys(config).length}
      open={open}
      destroyOnHidden
      wrapClassName="inventory-rebate-modal"
      onCancel={() => { setEditTarget(null); props.onClose(); }}
      width={900}
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
          <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }}
            scope="INVREBATE"
            form={form}
            className="inventory-rebate-form ui-form-spaced"
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
                  form.setFieldsValue({ rebate_type: kind });
                }}
              >
                {(["BUY", "SELL"] as RebateKind[]).map((kind) => <Radio key={kind} value={kind} disabled={!availableKinds.includes(kind)}>{configurableLabel("REBATE_TYPE", kind, REBATE_KIND_LABEL)}</Radio>)}
              </Radio.Group>
            </CfgItem>
            {!availableKinds.length ? <p className="muted">当前账号没有可关联的业务订单</p> : null}
            <div className="rebate-core-fields">
              <CfgItem
                name="amount"
                label="返点金额"
                rules={[{ required: true, message: "请输入返点金额" }, ...moneyRules("返点金额")]}
              >
                <MoneyInput placeholder="请输入返点金额" />
              </CfgItem>
              <ResponsibleEmployeeSelect name="operator_user_ids" label="操作人" employees={employees} />
            </div>
            <CustomFieldSection testIdSuffix="inventory-rebate" />
          </BusinessRegistrationForm>
        </FieldConfigContext.Provider>
      )}
      {!loading ? (
        <section className="inventory-rebate-details ui-stack" aria-label="返点明细">
          <Typography.Text strong>返点明细</Typography.Text>
          <div className="ui-form-spaced orders-event-list">
            <div className="orders-event-table inventory-rebate-table" role="table" aria-label="返点明细表">
              <div className="orders-event-row orders-event-row--header" role="row">
                {(["类型", "金额", "返点日期", "操作人", "操作"] as const).map((label) => (
                  <span key={label} role="columnheader">{label}</span>
                ))}
              </div>
              {rebates.length ? rebates.map((row) => (
                <div key={row.id} className="orders-event-row" role="row">
                  <span role="cell">{row.rebate_type === "BUY" ? "买号返点" : "卖号返点"}</span>
                  <span role="cell"><MoneyText value={row.amount} /></span>
                  <span role="cell">{row.collected_on}</span>
                  <span role="cell">{row.operator_user_ids?.map((id) => employees.find((employee) => employee.id === id)?.display_name).filter(Boolean).join("、") || row.operator || "-"}</span>
                  <span role="cell">
                    <Space size={2}>
                      <PermissionButton
                        permission="order.event.post"
                        size="small"
                        onClick={() => {
                          editForm.setFieldsValue({
                            amount: row.amount,
                            collected_on: row.collected_on,
                            note: row.note ?? "",
                            operator_user_ids: row.operator_user_ids ?? undefined,
                          });
                          setEditTarget(row);
                        }}
                      >编辑</PermissionButton>
                      {/* 2026-11-12 裁决：返点不可删除/作废；退回走资金中心录入 OUT 支出。 */}
                    </Space>
                  </span>
                </div>
              )) : (
                <div className="orders-event-row inventory-rebate-table__empty" role="row">
                  <span role="cell">暂无返点明细</span>
                </div>
              )}
            </div>
          </div>
        </section>
      ) : null}
    </BusinessActionModal>
    {/* 内层「编辑返点」与外层「登记返点」必须是兄弟节点，不能作为其 children。
        嵌在 children 里时，React 合成事件的捕获阶段会沿 fiber 树回溯到外层内容根，
        外层挂在内容根上的 Esc 捕获处理器同样会触发 → 在编辑弹窗按 Esc 会把「登记返点」
        一起关掉，外层已填的返点金额直接丢失。E2E：inventory-rebate-nest.spec.ts。 */}
    <BusinessActionModal
      title={editTarget ? `编辑返点 · ${editTarget.rebate_no}` : "编辑返点"}
      fieldCount={4 + Object.keys(config).length}
      open={Boolean(editTarget)}
      onCancel={() => setEditTarget(null)}
      footer={null}
    >
      <FieldConfigContext.Provider value={config}>
        <BusinessRegistrationForm
        layout="horizontal"
        labelAlign="left"
        labelCol={{ flex: "108px" }}
        wrapperCol={{ flex: "auto" }} scope="INVREBATE" form={editForm} onFinish={submitEdit}>
          <div className="rebate-core-fields">
            <CfgItem name="amount" label="返点金额" rules={[{ required: true, message: "请输入返点金额" }, ...moneyRules("返点金额")]}> <MoneyInput /></CfgItem>
            <CfgItem name="collected_on" label="返点日期" rules={[{ required: true, message: "请输入返点日期" }]} getValueFromEvent={dateValueFromEvent} getValueProps={dateValueProps}><DateField /></CfgItem>
            <ResponsibleEmployeeSelect name="operator_user_ids" label="操作人" employees={employees} />
          </div>
          <CfgItem name="note" label="备注"><Input.TextArea rows={3} /></CfgItem>
          <PermissionButton permission="order.event.post" type="primary" htmlType="submit">保存</PermissionButton>
        </BusinessRegistrationForm>
      </FieldConfigContext.Provider>
    </BusinessActionModal>
    </>
  );
}
