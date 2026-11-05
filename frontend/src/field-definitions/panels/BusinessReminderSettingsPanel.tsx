import { Card, Form, InputNumber, Switch, Typography } from "antd";
import { useCallback, useEffect, useState } from "react";
import { optionSetsApi } from "../../shared/api/catalog";
import { normalizeError } from "../../shared/api/client";
import {
  buildBusinessReminderOptions,
  BUSINESS_REMINDER_CONFIG_CODE,
  DEFAULT_BUSINESS_REMINDER_CONFIG,
  parseBusinessReminderConfig,
  type BusinessReminderConfig,
} from "../../app/businessReminderConfig";
import { appMessage } from "../../shared/ui/appFeedback";
import { BusinessRegistrationForm, ErrorBanner, PermissionButton, PermissionGate } from "../../shared/ui";

export function BusinessReminderSettingsPanel() {
  const [form] = Form.useForm<BusinessReminderConfig>();
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const config = await optionSetsApi.get(BUSINESS_REMINDER_CONFIG_CODE);
      form.setFieldsValue(parseBusinessReminderConfig(config?.options));
      setError(null);
    } catch (err) {
      form.setFieldsValue(DEFAULT_BUSINESS_REMINDER_CONFIG);
      setError(normalizeError(err));
    } finally {
      setLoading(false);
    }
  }, [form]);

  useEffect(() => { void load(); }, [load]);

  const save = async (values: BusinessReminderConfig) => {
    try {
      await optionSetsApi.update(BUSINESS_REMINDER_CONFIG_CODE, {
        options: buildBusinessReminderOptions(values),
      });
      appMessage.success("业务提醒配置已保存");
      await load();
    } catch (err) {
      setError(normalizeError(err));
    }
  };

  return (
    <Card className="glass" title="业务提醒">
      <ErrorBanner error={error} onRetry={() => void load()} />
      <Typography.Paragraph type="secondary">
        控制工作台业务总览中的提醒规则。库存提醒按入库天数计算，分润和逾期合约提醒可单独关闭。
      </Typography.Paragraph>
      <PermissionGate permission="option-set.manage">
        <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} form={form} onFinish={save} initialValues={DEFAULT_BUSINESS_REMINDER_CONFIG} disabled={loading || Boolean(error)}>
          <Form.Item
            name="inventoryAgingDays"
            label="库存订单超过多少天提醒"
            rules={[{ required: true, message: "请输入提醒天数" }]}
          >
            <InputNumber min={1} max={365} precision={0} addonAfter="天" />
          </Form.Item>
          <Form.Item name="profitNotificationsEnabled" label="新的分润通知" valuePropName="checked">
            <Switch checkedChildren="开启" unCheckedChildren="关闭" />
          </Form.Item>
          <Form.Item name="overdueInstallmentsEnabled" label="逾期合约提醒" valuePropName="checked">
            <Switch checkedChildren="开启" unCheckedChildren="关闭" />
          </Form.Item>
          <PermissionButton permission="option-set.manage" type="primary" htmlType="submit">保存配置</PermissionButton>
        </BusinessRegistrationForm>
      </PermissionGate>
    </Card>
  );
}
