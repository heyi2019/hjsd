import { Alert, Form, Input, InputNumber, Space, Typography } from "antd";
import { BusinessActionModal, BusinessForm, Select } from "../shared/ui";
import { useEffect, useState } from "react";
import {
  configToFields,
  fieldsToConfig,
  policyConfigFields,
  policyHasConfig,
  rateTableTotal,
  type PolicyFieldDef,
} from "./policyConfigSchema";
import { today } from "./policyConstants";

export interface PolicyVersionSubmit {
  effective_from: string;
  effective_to?: string;
  config: Record<string, unknown>;
  note?: string;
}

interface PolicyVersionEditorModalProps {
  open: boolean;
  code: string;
  /** 预填的初始配置（通常取当前生效版本的 config）。 */
  initialConfig: Record<string, unknown>;
  confirmLoading: boolean;
  onCancel: () => void;
  onOk: (values: PolicyVersionSubmit) => void;
}

/** 单个字段的控件：纯由 schema 的 kind 决定，新增字段不需要改这里。
 * 注意必须是**函数返回元素**而不是自定义组件：antd Form.Item 通过 cloneElement
 * 给子元素注入 id/value/onChange，多包一层组件会截断注入，label 也就关联不上。 */
function renderControl(field: PolicyFieldDef) {
  if (field.kind === "select") return <Select options={field.options} />;
  if (field.kind === "number") {
    return (
      <InputNumber
        min={field.min}
        max={field.max}
        precision={0}
        placeholder={field.placeholder}
        className="ui-control-width-160"
      />
    );
  }
  if (field.kind === "percent") {
    return (
      <InputNumber
        min={field.min ?? 0}
        max={field.max ?? 100}
        addonAfter="%"
        placeholder={field.placeholder}
        className="ui-control-width-160"
      />
    );
  }
  return <Input placeholder={field.placeholder} />;
}

/** 字段的后端消费状态说明：calc 真影响计算，snapshot 只随版本留痕。
 *  放在 extra 而不是 label 里——label 文本被测试用 getByLabelText 精确匹配。 */
function renderFieldExtra(field: PolicyFieldDef) {
  const calc = field.effective === "calc";
  return (
    <>
      {calc ? <strong>参与计算</strong> : <span className="muted">仅留痕</span>}
      {field.help ? ` · ${field.help}` : null}
    </>
  );
}

/** 声明式配置编辑器：按 schema 渲染控件，替代裸 JSON 文本框。
 * 保存即生成新版本并立即发布（无独立审批环节）。 */
export function PolicyVersionEditorModal({
  open,
  code,
  initialConfig,
  confirmLoading,
  onCancel,
  onOk,
}: PolicyVersionEditorModalProps) {
  const [form] = Form.useForm<Record<string, unknown>>();
  const [formError, setFormError] = useState<string | null>(null);
  const fields = policyConfigFields(code);
  const configurable = policyHasConfig(code);

  useEffect(() => {
    if (!open) return;
    setFormError(null);
    form.setFieldsValue({
      effective_from: today(),
      effective_to: undefined,
      note: undefined,
      ...configToFields(code, initialConfig),
    });
  }, [open, code, initialConfig, form]);

  const onFinish = (values: Record<string, unknown>) => {
    const { effective_from, effective_to, note, ...rest } = values;
    // 合计型费率表（提成四项比例）：合计不为 100 直接拦，避免存下无法执行的模板。
    for (const field of fields) {
      if (field.kind !== "rate-table" || field.sumTo == null) continue;
      const total = rateTableTotal(rest[field.key] as Record<string, unknown> | undefined, field.rows);
      if (Math.abs(total - field.sumTo) > 0.001) {
        setFormError(`${field.label}合计必须为 ${field.sumTo}%，当前为 ${total}%。`);
        return;
      }
    }
    const config = fieldsToConfig(code, rest);
    // 后端拒绝空 config（app/policy/service.py:86），这里先拦住并说明，避免 422 弹错。
    if (Object.keys(config).length === 0) {
      setFormError("请至少填写一项规则参数后再保存。");
      return;
    }
    setFormError(null);
    onOk({
      effective_from: String(effective_from),
      effective_to: effective_to ? String(effective_to) : undefined,
      config,
      note: note ? String(note) : undefined,
    });
  };

  return (
    <BusinessActionModal
      open={open}
      title="设置配置"
      okText="保存"
      cancelText="取消"
      confirmLoading={confirmLoading}
      okButtonProps={{ disabled: !configurable }}
      onCancel={onCancel}
      onOk={() => void form.submit()}
    >
      <BusinessForm form={form} onFinish={onFinish}>
        <Space direction="horizontal" size="middle" className="policy-version-date-row">
          <Form.Item
            name="effective_from"
            label="生效日期"
            rules={[{ required: true, message: "请选择生效日期" }]}
            className="policy-version-date-row__item"
          >
            <Input type="date" />
          </Form.Item>
          <Form.Item name="effective_to" label="失效日期" className="policy-version-date-row__item">
            <Input type="date" />
          </Form.Item>
        </Space>

        {!configurable ? (
          <Typography.Paragraph type="secondary">
            该规则由系统固定口径执行，暂无可配置参数。如需参数化，须先明确后端计算口径再开放配置。
          </Typography.Paragraph>
        ) : (
          fields.map((field) =>
            field.kind === "rate-table" ? (
              // 多行费率表：外层只做分组标签，内层每行独立绑定 config[field.key][row.key]。
              <Form.Item key={field.key} label={field.label} extra={renderFieldExtra(field)}>
                <Space wrap size="large">
                  {(field.rows ?? []).map((row) => (
                    <Form.Item key={row.key} name={[field.key, row.key]} label={row.label} className="policy-rate-row">
                      <InputNumber min={0} max={100} addonAfter="%" className="ui-control-width-160" />
                    </Form.Item>
                  ))}
                </Space>
              </Form.Item>
            ) : (
              <Form.Item
                key={field.key}
                name={field.key}
                label={field.label}
                extra={renderFieldExtra(field)}
                rules={field.required ? [{ required: true, message: `请填写${field.label}` }] : undefined}
              >
                {renderControl(field)}
              </Form.Item>
            ),
          )
        )}

        {formError ? <Alert type="warning" showIcon message={formError} className="ui-form-spaced" /> : null}

        <Form.Item name="note" label="变更说明">
          <Input.TextArea rows={2} placeholder="可选，说明本次版本变更" />
        </Form.Item>

        <Typography.Paragraph type="secondary">
          参数随版本固化，历史单据按建单时的快照计算。目前只有<strong>返点费率</strong>被后端读取
          （仅在登记返点时未手填费率的情况下生效）；<strong>提成分配比例</strong>按动作留存口径，
          订单「分润」仍按单录入；分期、跌价、退款的参数仅作口径留痕，接入计算前不改变金额。
        </Typography.Paragraph>
      </BusinessForm>
    </BusinessActionModal>
  );
}
