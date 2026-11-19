import { CfgItem, FieldConfigScope } from "../../business/ConfigurableField";
import { Form, InputNumber, Switch, Typography } from "antd";
import { useCallback, useEffect, useState } from "react";
import { optionSetsApi } from "../../shared/api/options.api";
import { normalizeError, type NormalizedError } from "../../shared/api/client";
import {
  buildBusinessReminderOptions,
  BUSINESS_REMINDER_CONFIG_CODE,
  DEFAULT_BUSINESS_REMINDER_CONFIG,
  parseBusinessReminderConfig,
  type BusinessReminderConfig,
} from "../../app/businessReminderConfig";
import { appMessage } from "../../shared/ui/appFeedback";
import { useSettingsResource } from "../../shared/state/useSettingsResource";
import { BusinessRegistrationForm, ErrorBanner, PermissionButton, PermissionGate } from "../../shared/ui";

export function BusinessReminderSettingsPanel() {
  const [form] = Form.useForm<BusinessReminderConfig>();
  const [mutationError, setMutationError] = useState<NormalizedError | null>(null);

  const load = useCallback(async () => {
    const config = await optionSetsApi.get(BUSINESS_REMINDER_CONFIG_CODE);
    return parseBusinessReminderConfig(config?.options);
  }, []);
  const handleLoadError = useCallback(() => {
    form.setFieldsValue(DEFAULT_BUSINESS_REMINDER_CONFIG);
  }, [form]);
  const { data: loadedConfig, loading, error: loadError, reload } = useSettingsResource(load, { onError: handleLoadError });
  const error = mutationError ?? loadError;

  useEffect(() => {
    if (loadedConfig) form.setFieldsValue(loadedConfig);
  }, [form, loadedConfig]);

  const reloadSection = useCallback(async () => {
    setMutationError(null);
    await reload();
  }, [reload]);

  const save = async (values: BusinessReminderConfig) => {
    try {
      await optionSetsApi.update(BUSINESS_REMINDER_CONFIG_CODE, {
        options: buildBusinessReminderOptions({ ...DEFAULT_BUSINESS_REMINDER_CONFIG, ...loadedConfig, ...values }),
      });
      appMessage.success("业务提醒配置已保存");
      setMutationError(null);
      await reload();
    } catch (err) {
      setMutationError(normalizeError(err));
    }
  };

  return (
    <section className="business-reminder-settings">
      <ErrorBanner error={error} onRetry={() => void reloadSection()} retrying={loading} />
      <Typography.Paragraph type="secondary">
        控制工作台业务总览中的提醒规则。库存提醒按入库天数计算，分润和逾期合约提醒可单独关闭。
      </Typography.Paragraph>
      <PermissionGate permission="option-set.manage">
        <FieldConfigScope scope="SYSREMIND" active={true}><BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} form={form} onFinish={save} initialValues={DEFAULT_BUSINESS_REMINDER_CONFIG} disabled={loading || Boolean(error)}>
          <CfgItem
            name="inventoryAgingDays"
            label="库存订单超过多少天提醒"
            rules={[{ required: true, message: "请输入提醒天数" }]}
          >
            <InputNumber min={1} max={365} precision={0} suffix="天" />
          </CfgItem>
          <CfgItem name="profitNotificationsEnabled" label="新的分润通知" valuePropName="checked">
            <Switch checkedChildren="开启" unCheckedChildren="关闭" />
          </CfgItem>
          <CfgItem name="overdueInstallmentsEnabled" label="逾期合约提醒" valuePropName="checked">
            <Switch checkedChildren="开启" unCheckedChildren="关闭" />
          </CfgItem>
          <PermissionButton permission="option-set.manage" type="primary" htmlType="submit">保存配置</PermissionButton>
        </BusinessRegistrationForm></FieldConfigScope>
      </PermissionGate>
    </section>
  );
}
