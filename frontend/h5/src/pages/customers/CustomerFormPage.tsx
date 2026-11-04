/**
 * 客户档案（新建 / 编辑共用）。
 *
 * 「客户类型」不在这里设置 —— 客户每一单的角色都可能不同（这次是卖方、下次是买方），
 * 角色落在 `order_customer_roles`，逐单判定。档案上只保留可长期复用的联系方式。
 *
 * 重复档案提示：新建时后端会回 `duplicate_candidates`，必须留在本页提示，
 * 否则用户会一路建下去，之后合并的成本比补录高一个量级。
 */
import { useCallback, useEffect, useState } from "react";
import { createCustomer, fetchCustomerDetail, updateCustomer, type CustomerRow } from "../../api";
import {
  Field,
  FormError,
  FormPage,
  FormSection,
  PickerField,
  SubmitBar,
  TextArea,
  TextInput,
} from "../../forms/controls";
import { useOptionSet } from "../../forms/useOptionSets";
import { goBack, navigate } from "../../router";

const SOURCE_FALLBACK = ["自营", "微博", "小红书", "闲鱼", "同行推荐", "其他"].map((value) => ({
  value,
  label: value,
}));

export function CustomerFormPage({ customerId }: { customerId?: number }) {
  const editing = customerId != null;
  const [customer, setCustomer] = useState<CustomerRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [duplicates, setDuplicates] = useState(0);
  const sourceOptions = useOptionSet("CUSTOMER_SOURCE");

  const [v, setV] = useState({
    display_name: "",
    contact_name: "",
    phone: "",
    wechat: "",
    qq: "",
    source: "",
    note: "",
  });

  useEffect(() => {
    if (customerId == null) return undefined;
    let alive = true;
    void fetchCustomerDetail(customerId)
      .then((detail) => {
        if (!alive) return;
        setCustomer(detail.customer);
        setV({
          display_name: detail.customer.display_name,
          contact_name: detail.customer.contact_name ?? "",
          phone: detail.customer.phone ?? "",
          wechat: detail.customer.wechat ?? "",
          qq: "",
          source: detail.customer.source ?? "",
          note: detail.customer.note ?? "",
        });
      })
      .catch((cause: unknown) => {
        if (alive) setError(cause instanceof Error ? cause.message : "加载客户失败");
      });
    return () => {
      alive = false;
    };
  }, [customerId, editing]);

  const submit = useCallback(async () => {
    const next: Record<string, string> = {};
    if (!v.display_name.trim()) next.display_name = "客户姓名必填";
    if (v.phone.trim() && !/^\d{5,20}$/.test(v.phone.trim())) next.phone = "手机号只填数字";
    setErrors(next);
    if (Object.keys(next).length) return;

    setBusy(true);
    setError(null);
    try {
      const payload = {
        display_name: v.display_name.trim(),
        contact_name: v.contact_name.trim() || null,
        phone: v.phone.trim() || null,
        wechat: v.wechat.trim() || null,
        qq: v.qq.trim() || null,
        source: v.source.trim() || null,
        note: v.note.trim() || null,
      };
      if (editing) {
        await updateCustomer(customerId, payload);
        navigate(`/customers/${customerId}`, true);
        return;
      }
      const result = await createCustomer(payload);
      const candidates = (result as { duplicate_candidates?: unknown[] }).duplicate_candidates;
      if (Array.isArray(candidates) && candidates.length > 0) {
        // 有疑似重复时停在本页：让用户自己决定是继续还是去合并。
        setDuplicates(candidates.length);
        setCustomer(result.customer);
        return;
      }
      navigate(`/customers/${result.customer.id}`, true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }, [customerId, editing, v]);

  return (
    <FormPage
      title={editing ? "编辑客户" : "新建客户"}
      subtitle={customer?.customer_no}
      onBack={() => goBack(editing ? `/customers/${customerId}` : "/customers")}
      footer={
        <SubmitBar
          label={editing ? "保存" : "创建客户"}
          busy={busy}
          hint={duplicates > 0 ? "已创建，但存在疑似重复档案" : undefined}
          secondary={
            duplicates > 0 && customer
              ? { label: "仍然进入", onClick: () => navigate(`/customers/${customer.id}`, true) }
              : undefined
          }
          onClick={() => void submit()}
        />
      }
    >
      <FormError error={error} />
      {duplicates > 0 ? (
        <div className="h5-alert" role="status">
          系统发现 {duplicates} 条疑似重复档案（同名或同手机号）。建议先回客户列表核对，
          确认确实是同一人时再合并，避免同一客户被拆成两份交易记录。
        </div>
      ) : null}

      <FormSection title="基本信息">
        <Field label="客户姓名" required error={errors.display_name}>
          <TextInput
            value={v.display_name}
            onChange={(next) => setV((prev) => ({ ...prev, display_name: next }))}
            placeholder="用于列表展示的名称"
          />
        </Field>
        <Field label="联系人" hint="与客户姓名不同时填写">
          <TextInput
            value={v.contact_name}
            onChange={(next) => setV((prev) => ({ ...prev, contact_name: next }))}
          />
        </Field>
        <Field label="手机号" error={errors.phone}>
          <TextInput
            value={v.phone}
            onChange={(next) => setV((prev) => ({ ...prev, phone: next }))}
            inputMode="tel"
          />
        </Field>
        <Field label="微信号">
          <TextInput value={v.wechat} onChange={(next) => setV((prev) => ({ ...prev, wechat: next }))} />
        </Field>
        <Field label="QQ">
          <TextInput value={v.qq} onChange={(next) => setV((prev) => ({ ...prev, qq: next }))} />
        </Field>
      </FormSection>

      <FormSection title="来源与备注">
        <PickerField
          label="客户来源"
          value={v.source}
          options={sourceOptions.length ? sourceOptions : SOURCE_FALLBACK}
          onChange={(next) => setV((prev) => ({ ...prev, source: next }))}
          searchable
          allowClear
          placeholder="请选择客户来源"
        />
        <Field label="备注">
          <TextArea
            value={v.note}
            onChange={(next) => setV((prev) => ({ ...prev, note: next }))}
            rows={3}
            placeholder="可选填"
          />
        </Field>
      </FormSection>

      <p className="h5-footnote">
        客户角色（卖方 / 买方 / 寄售方 / 分期客户）在每张订单上单独判定，档案本身不设固定类型。
      </p>
    </FormPage>
  );
}
