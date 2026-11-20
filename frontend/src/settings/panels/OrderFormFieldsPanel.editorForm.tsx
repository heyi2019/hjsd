import { CfgGroup, CfgItem, FieldConfigScope } from "../../business/ConfigurableField";
/** 字段编辑表单 JSX：从 useOrderFormFieldsPanelController 逐字提取（纯渲染函数，不调用 hooks）。 */
import { Form, Input, InputNumber, Space, Switch } from "antd";
import type { FormInstance } from "antd";
import type { ReactElement } from "react";
import { PermissionButton, PermissionGate, BusinessRegistrationForm, Select } from "../../shared/ui";
import { CONDITION_OP_OPTIONS, FLOW_DIRECTION_OPTIONS } from "./OrderFormFieldsPanel.fragments";
import type { OrderFormField } from "../../shared/api/types/forms";

type LabelOption = { value: string; label: string };

export function renderOrderFormFieldEditorForm(params: {
  form: FormInstance;
  editorFormId: string;
  submit: (values: Record<string, unknown>) => void | Promise<void>;
  editingId: number | null;
  fixedLabelField: boolean;
  sectionReady: boolean;
  editorFieldTypeOptions: LabelOption[];
  orderedSectionOptions: LabelOption[];
  editorSection: string | undefined;
  needsOptions: boolean;
  managedOptionField: boolean;
  onConfigureGameTypes?: () => void;
  onConfigureIntermediaryPlatforms?: () => void;
  onConfigurePools?: () => void;
  onConfigurePartySources?: () => void;
  editingField: OrderFormField | null;
  condFieldKey: string | undefined;
  dependencyOptions: LabelOption[];
  triggerOptions: LabelOption[];
  condOp: string;
  cancelEditing: () => void;
}): ReactElement {
  const {
    form, editorFormId, submit, editingId, fixedLabelField, sectionReady,
    editorFieldTypeOptions, orderedSectionOptions, editorSection,
    needsOptions, managedOptionField,
    onConfigureGameTypes, onConfigureIntermediaryPlatforms, onConfigurePools, onConfigurePartySources,
    editingField, condFieldKey, dependencyOptions, triggerOptions, condOp, cancelEditing,
  } = params;
  return (
    <PermissionGate permission="field-definition.manage">
      <FieldConfigScope scope="SYSFIELD" active={true}><BusinessRegistrationForm
        form={form}
        id={editorFormId}
        layout="inline"
        onFinish={submit}
        disabled={!sectionReady}
        className="ui-form-spaced"
        initialValues={{ field_type: "TEXT", sort_order: 0, section: "EXTRA" }}
      >
        <CfgItem alwaysActive name="field_key" label="字段键" rules={[{ required: true }, { pattern: /^[a-z][a-z0-9_]*$/, message: "仅支持小写字母与下划线，且以小写字母开头" }]}>
          <Input placeholder="按小写字母和下划线填写" disabled={editingId !== null} />
        </CfgItem>
        <CfgItem alwaysActive
          name="label"
          label="标签"
          rules={[{ required: true }]}
          tooltip={fixedLabelField ? "系统统一术语，字段名称不可修改" : undefined}
          extra={fixedLabelField ? "系统统一术语，全站统一显示，不可改名" : undefined}
        >
          <Input placeholder="页面显示名" disabled={fixedLabelField} />
        </CfgItem>
        <CfgItem name="field_type" label="类型">
          <Select options={editorFieldTypeOptions} className="ui-control-width-180" disabled={editingId !== null} />
        </CfgItem>
        <CfgItem name="section" label="归属板块">
          <Select
            options={orderedSectionOptions}
            className="ui-control-width-160"
            popupClassName="order-form-section-filter-pop"
          />
        </CfgItem>
        {editorSection === "FINANCE" ? (
          <CfgItem name="flow_direction" label="资金流向性质">
            <Select allowClear placeholder="请选择资金流向性质" options={[...FLOW_DIRECTION_OPTIONS]} className="ui-control-width-160" popupClassName="order-form-field-option-pop" />
          </CfgItem>
        ) : null}
        {needsOptions && !managedOptionField && (
          <CfgGroup name="options" label="选项（值 / 展示名）">
            <Form.List name="options">
              {(fields, { add, remove }) => (
                <Space direction="vertical" className="ui-control-full">
                  {fields.map(({ key, name, ...restField }) => (
                    <Space key={key} align="baseline">
                      <Form.Item {...restField} name={[name, "value"]} rules={[{ required: true, message: "值必填" }]} noStyle>
                        <Input placeholder="枚举值（后端编码）" className="ui-control-width-200" />
                      </Form.Item>
                      <Form.Item {...restField} name={[name, "label"]} noStyle>
                        <Input placeholder="展示名（可空，默认同值）" className="ui-control-width-200" />
                      </Form.Item>
                      <PermissionButton permission="field-definition.manage" danger size="small" onClick={() => remove(name)}>
                        删
                      </PermissionButton>
                    </Space>
                  ))}
                  <PermissionButton permission="field-definition.manage" onClick={() => add({ value: "", label: "" })}>
                    添加选项
                  </PermissionButton>
                </Space>
              )}
            </Form.List>
          </CfgGroup>
        )}
        {editingField?.field_key === "game_type" && onConfigureGameTypes ? (
          <Form.Item>
            <PermissionButton permission="field-definition.manage" onClick={onConfigureGameTypes}>配置游戏类型</PermissionButton>
          </Form.Item>
        ) : null}
        {editingField?.field_key === "channel_region" && onConfigureGameTypes ? (
          <Form.Item>
            <PermissionButton permission="field-definition.manage" onClick={onConfigureGameTypes}>配置游戏类型渠道／区服</PermissionButton>
          </Form.Item>
        ) : null}
        {editingField?.field_key === "intermediary_platform" && onConfigureIntermediaryPlatforms ? (
          <Form.Item>
            <PermissionButton permission="field-definition.manage" onClick={onConfigureIntermediaryPlatforms}>配置经手平台</PermissionButton>
          </Form.Item>
        ) : null}
        {editingField && ["intermediary_type", "compensation_type"].includes(editingField.field_key) && onConfigureIntermediaryPlatforms ? (
          <Form.Item>
            <PermissionButton permission="field-definition.manage" onClick={onConfigureIntermediaryPlatforms}>配置中介业务</PermissionButton>
          </Form.Item>
        ) : null}
        {editingField?.field_key === "payment_pool_id" && onConfigurePools ? (
          <Form.Item>
            <PermissionButton permission="field-definition.manage" onClick={onConfigurePools}>配置资金账户</PermissionButton>
          </Form.Item>
        ) : null}
        {editingField && ["customer_source", "dg_customer_source"].includes(editingField.field_key) && onConfigurePartySources ? (
          <Form.Item>
            <PermissionButton permission="field-definition.manage" onClick={onConfigurePartySources}>
              配置客户来源
            </PermissionButton>
          </Form.Item>
        ) : null}
        <CfgItem
          name="required"
          label="必填"
          valuePropName="checked"
          tooltip={condFieldKey ? "已配置条件必填，二者互斥；清空依赖字段即可改回必填" : undefined}
        >
          <Switch disabled={Boolean(condFieldKey)} />
        </CfgItem>
        <CfgItem name="cond_field" label="条件必填·依赖字段">
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="不启用"
            options={dependencyOptions}
            className="ui-control-width-180"
            popupClassName="order-form-field-option-pop"
            onChange={(value: string | undefined) => {
              if (value) form.setFieldsValue({ required: false, cond_op: form.getFieldValue("cond_op") ?? "eq" });
            }}
          />
        </CfgItem>
        {condFieldKey ? (
          <CfgItem name="cond_op" label="条件" initialValue="eq">
            <Select options={CONDITION_OP_OPTIONS} className="ui-control-width-110" popupClassName="order-form-field-option-pop" />
          </CfgItem>
        ) : null}
        {condFieldKey && condOp !== "filled" ? (
          <CfgItem name="cond_values" label="触发值">
            <Select
              mode="tags"
              options={triggerOptions}
              placeholder="选值或输入后回车"
              className="ui-control-width-200"
              popupClassName="order-form-field-option-pop"
            />
          </CfgItem>
        ) : null}
        <CfgItem name="sort_order" label="排序"><InputNumber min={0} className="ui-control-width-90" /></CfgItem>
        <Form.Item>
          <PermissionButton permission="field-definition.manage" type="primary" htmlType="submit" form={editorFormId}>
            {editingId === null ? "新增字段" : "保存字段"}
          </PermissionButton>
        </Form.Item>
        {editingId !== null && (
          <Form.Item>
            <PermissionButton permission="field-definition.manage" onClick={cancelEditing}>取消编辑</PermissionButton>
          </Form.Item>
        )}
      </BusinessRegistrationForm></FieldConfigScope>
    </PermissionGate>
  );

}
