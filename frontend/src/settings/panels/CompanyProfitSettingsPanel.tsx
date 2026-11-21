import { Form, InputNumber } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { profitAllocationApi } from "../../shared/api/profitAllocation.api";
import { normalizeError, type NormalizedError } from "../../shared/api/client";
import { useSettingsResource } from "../../shared/state/useSettingsResource";
import { BusinessRegistrationForm, ErrorBanner, PermissionButton, PermissionGate } from "../../shared/ui";
import { appMessage } from "../../shared/ui/appFeedback";
import "./CompanyProfitSettingsPanel.css";

type Values = { profit_rate: number; loss_rate: number };

export function CompanyProfitSettingsPanel() {
  const [form] = Form.useForm<Values>();
  const [mutationError, setMutationError] = useState<NormalizedError | null>(null);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const load = useCallback(() => profitAllocationApi.companySettings(), []);
  const { data, loading, error: loadError, reload } = useSettingsResource(load);
  const error = mutationError ?? loadError;
  useEffect(() => {
    if (data) form.setFieldsValue({ profit_rate: Number(data.profit_rate), loss_rate: Number(data.loss_rate) });
  }, [data, form]);
  const save = async (values: Values) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    try {
      await profitAllocationApi.updateCompanySettings({ profit_rate: String(values.profit_rate), loss_rate: String(values.loss_rate) });
      setMutationError(null);
      appMessage.success("公司分润设置已保存");
      await reload();
    } catch (cause) { setMutationError(normalizeError(cause)); }
    finally { inFlight.current = false; setSaving(false); }
  };
  return <section>
    <ErrorBanner error={error} onRetry={() => { setMutationError(null); void reload(); }} retrying={loading} />
    <PermissionGate permission="policy.manage">
      <BusinessRegistrationForm className="company-profit-settings__form" form={form} layout="vertical" labelCol={{}} wrapperCol={{}} onFinish={save} disabled={loading || Boolean(error)}>
        <div className="company-profit-settings__fields">
        <Form.Item name="profit_rate" label="盈利时公司比例" rules={[{ required: true, message: "请输入盈利时公司比例" }, { type: "number", min: 0, max: 100, message: "请输入 0 至 100 的比例" }]}>
          <InputNumber min={0} max={100} precision={2} suffix="%" />
        </Form.Item>
        <Form.Item name="loss_rate" label="亏损时公司比例" rules={[{ required: true, message: "请输入亏损时公司比例" }, { type: "number", min: 0, max: 100, message: "请输入 0 至 100 的比例" }]}>
          <InputNumber min={0} max={100} precision={2} suffix="%" />
        </Form.Item>
        </div>
        <div className="company-profit-settings__actions"><PermissionButton permission="policy.manage" type="primary" htmlType="submit" loading={saving}>保存</PermissionButton></div>
      </BusinessRegistrationForm>
    </PermissionGate>
  </section>;
}
