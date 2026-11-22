import { CalendarOutlined } from "@ant-design/icons";
import { Form, InputNumber } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { CfgItem, FieldConfigScope } from "../../shared/forms/ConfigurableField";
import { currentReportPeriod } from "../../shared/lib/reportPeriod";
import { optionSetsApi } from "../../shared/api/options.api";
import { normalizeError, type NormalizedError } from "../../shared/api/client";
import { announceBusinessPeriodChange, BUSINESS_PERIOD_CODE } from "../../shared/state/businessPeriod";
import { useSettingsResource } from "../../shared/state/useSettingsResource";
import { BusinessRegistrationForm, ErrorBanner, PermissionButton, PermissionGate } from "../../shared/ui";
import { appMessage } from "../../shared/ui/appFeedback";
import "./BusinessPeriodSettingsPanel.css";

export function BusinessPeriodSettingsPanel() {
  const [form] = Form.useForm<{ start_day: number }>();
  const startDay = Form.useWatch("start_day", form);
  const [mutationError, setMutationError] = useState<NormalizedError | null>(null);
  const [saving, setSaving] = useState(false);
  const saveInFlight = useRef(false);
  const load = useCallback(async () => {
    const config = await optionSetsApi.get(BUSINESS_PERIOD_CODE);
    const start = Number(config.options?.find((item) => item.value === "start_day")?.label);
    if (!Number.isInteger(start) || start < 1 || start > 31) throw new Error("当期起始日配置无效");
    return start;
  }, []);
  const { data, loading, error: loadError, reload } = useSettingsResource(load);
  const error = mutationError ?? loadError;
  const preview = Number.isInteger(startDay) && startDay >= 1 && startDay <= 31 ? currentReportPeriod(undefined, startDay) : null;
  useEffect(() => { if (data != null) form.setFieldsValue({ start_day: data }); }, [data, form]);
  const save = async ({ start_day }: { start_day: number }) => {
    if (saveInFlight.current) return;
    saveInFlight.current = true;
    setSaving(true);
    try {
      await optionSetsApi.update(BUSINESS_PERIOD_CODE, { options: [{ value: "start_day", label: String(start_day) }] });
      announceBusinessPeriodChange(start_day);
      setMutationError(null);
      appMessage.success("当期设置已保存");
      await reload();
    } catch (err) { setMutationError(normalizeError(err)); }
    finally { saveInFlight.current = false; setSaving(false); }
  };
  return <section className="business-period-settings">
    <ErrorBanner error={error} onRetry={() => { setMutationError(null); void reload(); }} retrying={loading} />
    <div className="business-period-settings__intro">
      <span className="business-period-settings__icon" aria-hidden="true"><CalendarOutlined /></span>
      <div>
        <div className="business-period-settings__heading">统一业务周期</div>
        <p>设置一次，每月自动沿用，工作台与经营中心共用。</p>
      </div>
    </div>
    <PermissionGate permission="option-set.manage">
      <FieldConfigScope scope="SYSPERIOD" active>
        <BusinessRegistrationForm className="business-period-settings__form" form={form} layout="vertical" labelCol={{}} wrapperCol={{}} onFinish={save} disabled={loading || Boolean(error)}>
          <div className="business-period-settings__content">
            <div className="business-period-settings__field">
              <CfgItem alwaysActive name="start_day" label="每月起始日" rules={[
                { required: true, message: "请输入每月起始日" },
                { validator: (_, value) => Number.isInteger(value) && value >= 1 && value <= 31 ? Promise.resolve() : Promise.reject(new Error("请输入 1 至 31 的整数")) },
              ]}>
                <InputNumber min={1} max={31} precision={0} suffix="日" />
              </CfgItem>
              <p>可设置 1 至 31 日；当月没有对应日期时，从当月最后一天开始。</p>
            </div>
            <div className="business-period-settings__preview" aria-live="polite">
              <span>周期预览</span>
              {preview ? <><strong>{`每月 ${startDay} 日开始`}</strong><p>本期：{preview.from} 至 {preview.to}</p></> : <p>输入有效起始日后查看周期</p>}
            </div>
          </div>
          <div className="business-period-settings__actions">
            <PermissionButton permission="option-set.manage" type="primary" htmlType="submit" loading={saving}>保存当期设置</PermissionButton>
          </div>
        </BusinessRegistrationForm>
      </FieldConfigScope>
    </PermissionGate>
  </section>;
}
