/**
 * 新建需求线索：先记「客户想要什么」，成单后再转成订单。
 * 客户必须已存在（需求是挂在客户档案上的意向，不单独建档）。
 */
import { useCallback, useEffect, useState } from "react";
import { createLead, listCustomers, type CustomerRow } from "../../api";
import {
  ChipField,
  Field,
  FormError,
  FormPage,
  FormSection,
  MoneyInput,
  PickerField,
  SubmitBar,
  TextArea,
  TextInput,
} from "../../forms/controls";
import { goBack, navigate } from "../../router";

const TYPES = [
  { value: "FIND_ACCOUNT", label: "找号" },
  { value: "SELL_ACCOUNT", label: "卖号" },
  { value: "SPECIFIC_SEARCH", label: "指定找号" },
];

export function LeadFormPage() {
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [v, setV] = useState({
    customer_id: "",
    request_type: "FIND_ACCOUNT",
    budget: "",
    target: "",
    note: "",
  });

  useEffect(() => {
    let alive = true;
    void listCustomers({ limit: 500, status: "ACTIVE" })
      .then((page) => {
        if (alive) setCustomers(page.items ?? []);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const submit = useCallback(async () => {
    const next: Record<string, string> = {};
    if (!v.customer_id) next.customer_id = "请选择客户";
    if (!v.target.trim()) next.target = "请描述需求目标";
    setErrors(next);
    if (Object.keys(next).length) return;

    setBusy(true);
    setError(null);
    try {
      await createLead({
        customer_id: Number(v.customer_id),
        request_type: v.request_type,
        budget: v.budget || null,
        target: v.target.trim(),
        note: v.note.trim() || null,
      });
      navigate("/customers/leads", true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }, [v]);

  return (
    <FormPage
      title="新建需求"
      onBack={() => goBack("/customers/leads")}
      footer={<SubmitBar label="创建需求" busy={busy} onClick={() => void submit()} />}
    >
      <FormError error={error} />

      <FormSection title="需求内容">
        <PickerField
          label="客户"
          required
          value={v.customer_id}
          searchable
          options={customers.map((customer) => ({
            value: String(customer.id),
            label: customer.display_name,
            hint: customer.phone ?? customer.customer_no,
          }))}
          onChange={(next) => setV((prev) => ({ ...prev, customer_id: next }))}
          placeholder="搜索并选择客户"
          error={errors.customer_id}
        />
        <ChipField
          label="需求类型"
          value={v.request_type}
          options={TYPES}
          onChange={(next) => setV((prev) => ({ ...prev, request_type: next }))}
        />
        <Field label="预算">
          <MoneyInput value={v.budget} onChange={(next) => setV((prev) => ({ ...prev, budget: next }))} />
        </Field>
        <Field label="需求目标" required error={errors.target}>
          <TextArea
            value={v.target}
            onChange={(next) => setV((prev) => ({ ...prev, target: next }))}
            rows={3}
            placeholder="例如：王者荣耀 安卓微信区，V10，预算 3000 内"
          />
        </Field>
        <Field label="备注">
          <TextArea value={v.note} onChange={(next) => setV((prev) => ({ ...prev, note: next }))} rows={2} />
        </Field>
      </FormSection>

      <p className="h5-footnote">需求只是意向登记；成单后在需求详情里「转单」关联到实际订单。</p>
    </FormPage>
  );
}
