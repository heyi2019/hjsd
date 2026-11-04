/**
 * 合作方档案（新建 / 编辑）。
 *
 * 类型（同行 / 供货方 / 平台 / 中介）一旦落库就参与订单参与方校验：
 * 提号单的供货方必须是 PEER，改了类型会让历史订单的角色对不上。所以编辑时
 * 类型只读，需要换类型请新建一个档案。
 */
import { useCallback, useEffect, useState } from "react";
import {
  createCounterparty,
  fetchCounterparty,
  setCounterpartyActive,
  updateCounterparty,
} from "../../api";
import {
  ChipField,
  Field,
  FormError,
  FormPage,
  FormSection,
  PickerField,
  SubmitBar,
  SwitchField,
  TextArea,
  TextInput,
} from "../../forms/controls";
import { useOptionSet } from "../../forms/useOptionSets";
import { goBack, navigate } from "../../router";

const TYPES = [
  { value: "PEER", label: "同行" },
  { value: "SUPPLIER", label: "供货方" },
  { value: "PLATFORM", label: "平台" },
  { value: "INTERMEDIARY", label: "中介" },
];

export function CounterpartyFormPage({ counterpartyId }: { counterpartyId?: number }) {
  const editing = counterpartyId != null;
  const [active, setActive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [loadedType, setLoadedType] = useState<string | null>(null);
  const sourceOptions = useOptionSet("PARTY_SOURCE");

  const [v, setV] = useState({
    display_name: "",
    type: "PEER",
    contact_name: "",
    phone: "",
    wechat: "",
    qq: "",
    source: "",
    note: "",
  });

  useEffect(() => {
    if (counterpartyId == null) return undefined;
    let alive = true;
    void fetchCounterparty(counterpartyId)
      .then((row) => {
        if (!alive) return;
        setLoadedType(row.type);
        setActive(row.status === "ACTIVE");
        setV({
          display_name: row.display_name,
          type: row.type,
          contact_name: row.contact_name ?? "",
          phone: row.phone ?? "",
          wechat: row.wechat ?? "",
          qq: row.qq ?? "",
          source: row.source ?? "",
          note: row.note ?? "",
        });
      })
      .catch((cause: unknown) => {
        if (alive) setError(cause instanceof Error ? cause.message : "加载失败");
      });
    return () => {
      alive = false;
    };
  }, [counterpartyId]);

  const submit = useCallback(async () => {
    const next: Record<string, string> = {};
    if (!v.display_name.trim()) next.display_name = "名称必填";
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
        await updateCounterparty(counterpartyId, payload);
        if (active !== undefined) await setCounterpartyActive(counterpartyId, active);
        navigate("/customers/counterparties", true);
        return;
      }
      await createCounterparty({ ...payload, type: v.type });
      navigate("/customers/counterparties", true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }, [active, counterpartyId, editing, v]);

  return (
    <FormPage
      title={editing ? "编辑合作方" : "新建合作方"}
      subtitle={loadedType ? `类型：${TYPES.find((item) => item.value === loadedType)?.label ?? loadedType}` : undefined}
      onBack={() => goBack("/customers/counterparties")}
      footer={<SubmitBar label={editing ? "保存" : "创建"} busy={busy} onClick={() => void submit()} />}
    >
      <FormError error={error} />

      <FormSection title="基本信息">
        <Field label="名称" required error={errors.display_name}>
          <TextInput
            value={v.display_name}
            onChange={(next) => setV((prev) => ({ ...prev, display_name: next }))}
            placeholder="公司名或同行昵称"
          />
        </Field>
        {editing ? (
          <Field label="类型" hint="类型参与订单参与方校验，创建后不可更改">
            <TextInput value={TYPES.find((item) => item.value === v.type)?.label ?? v.type} onChange={() => undefined} disabled />
          </Field>
        ) : (
          <ChipField
            label="类型"
            required
            value={v.type}
            options={TYPES}
            onChange={(next) => setV((prev) => ({ ...prev, type: next }))}
          />
        )}
        <Field label="联系人">
          <TextInput value={v.contact_name} onChange={(next) => setV((prev) => ({ ...prev, contact_name: next }))} />
        </Field>
        <Field label="手机号">
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
          label="来源"
          value={v.source}
          options={sourceOptions}
          onChange={(next) => setV((prev) => ({ ...prev, source: next }))}
          allowClear
          placeholder="可选填"
        />
        <Field label="备注">
          <TextArea value={v.note} onChange={(next) => setV((prev) => ({ ...prev, note: next }))} rows={3} />
        </Field>
        {editing ? (
          <SwitchField
            label="启用"
            hint="停用后不能再被新订单选用，历史订单不受影响"
            value={active}
            onChange={setActive}
          />
        ) : null}
      </FormSection>
    </FormPage>
  );
}
