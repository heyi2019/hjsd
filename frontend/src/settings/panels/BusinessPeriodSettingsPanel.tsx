import { Form, InputNumber, Typography } from "antd";
import { useCallback, useEffect, useState } from "react";
import { CfgItem, FieldConfigScope } from "../../business/ConfigurableField";
import { optionSetsApi } from "../../shared/api/options.api";
import { normalizeError, type NormalizedError } from "../../shared/api/client";
import { announceBusinessPeriodChange, BUSINESS_PERIOD_CODE } from "../../shared/state/businessPeriod";
import { useSettingsResource } from "../../shared/state/useSettingsResource";
import { BusinessRegistrationForm, ErrorBanner, PermissionButton, PermissionGate } from "../../shared/ui";
import { appMessage } from "../../shared/ui/appFeedback";

export function BusinessPeriodSettingsPanel() {
  const [form] = Form.useForm<{ start_day: number }>();
  const [mutationError, setMutationError] = useState<NormalizedError | null>(null);
  const load = useCallback(async () => {
    const config = await optionSetsApi.get(BUSINESS_PERIOD_CODE);
    const start = Number(config.options?.find((item) => item.value === "start_day")?.label);
    if (!Number.isInteger(start) || start < 1 || start > 31) throw new Error("当期起始日配置无效");
    return start;
  }, []);
  const { data, loading, error: loadError, reload } = useSettingsResource(load);
  const error = mutationError ?? loadError;
  useEffect(() => { if (data != null) form.setFieldsValue({ start_day: data }); }, [data, form]);
  const save = async ({ start_day }: { start_day: number }) => {
    try {
      await optionSetsApi.update(BUSINESS_PERIOD_CODE, { options: [{ value: "start_day", label: String(start_day) }] });
      announceBusinessPeriodChange(start_day);
      setMutationError(null);
      appMessage.success("当期设置已保存");
      await reload();
    } catch (err) { setMutationError(normalizeError(err)); }
  };
  return <section className="ui-stack">
    <ErrorBanner error={error} onRetry={() => { setMutationError(null); void reload(); }} retrying={loading} />
    <Typography.Paragraph type="secondary">设置一次后每月自动沿用，工作台与经营中心共用。月份没有对应日期时，从该月最后一天开始。</Typography.Paragraph>
    <PermissionGate permission="option-set.manage">
      <FieldConfigScope scope="SYSPERIOD" active>
        <BusinessRegistrationForm form={form} layout="vertical" onFinish={save} disabled={loading || Boolean(error)}>
          <CfgItem alwaysActive name="start_day" label="每月起始日" rules={[
            { required: true, message: "请输入每月起始日" },
            { validator: (_, value) => Number.isInteger(value) && value >= 1 && value <= 31 ? Promise.resolve() : Promise.reject(new Error("请输入 1 至 31 的整数")) },
          ]}>
            <InputNumber min={1} max={31} precision={0} />
          </CfgItem>
          <PermissionButton permission="option-set.manage" type="primary" htmlType="submit">保存当期设置</PermissionButton>
        </BusinessRegistrationForm>
      </FieldConfigScope>
    </PermissionGate>
  </section>;
}
