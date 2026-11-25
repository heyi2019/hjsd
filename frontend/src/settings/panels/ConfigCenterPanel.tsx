/** 配置中心（设置页首个页签）：顶部页签菜单 + 下方渲染对应「现有配置页面」。
 *
 * 设计意图（用户裁决 2026-10-31）：配置中心聚合字段、业务主数据与编号管理配置项到一页，
 * 顶部按类别列出这些配置项，点击即在下方切换显示对应的现有面板，不再各自独立成 Tab。
 *
 * 复用单一事实源 configCatalog.ts 的 SETTINGS_ITEMS 注册表（分组 / 标签 / 权限 / 只读），
 * 右侧直接挂载各配置项既有的面板组件（BusinessDictionaryPanel / OrderTypesPanel …），
 * 不重写任何配置逻辑；跨面板跳转（如表单字段里的「配置游戏类型」）改为在本中心内切换选中项。 */
import { Card, Form, Input, Space, Typography } from "antd";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import {
  CONFIG_GROUP_LABEL,
  CONFIG_CENTER_GROUP_ORDER,
  SETTINGS_ITEMS,
} from "../configCatalog";
import { useSession } from "../../shared/state/session";
import { normalizeError, type NormalizedError } from "../../shared/api/client";
import { optionSetsApi } from "../../shared/api/options.api";
import type { CustomDictionary } from "../../shared/api/types/common";
import { useReferenceRefresh } from "../../shared/hooks/useReferenceRefresh";
import { useSettingsResource } from "../../shared/state/useSettingsResource";
import { BusinessActionModal, BusinessRegistrationForm, ConfirmButton, ErrorBanner, InlineError, Select, StatusTag } from "../../shared/ui";
import { OptionDictionarySection } from "../options/IntermediaryPlatformSettingsPanel";
import { PANEL_REGISTRY } from "./panelRegistry";
import "./ConfigCenterPanel.css";

export function ConfigCenterPanel() {
  const { can } = useSession();
  const [selected, setSelected] = useState<string>("order-types");
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<NormalizedError | null>(null);
  const [createdSets, setCreatedSets] = useState<CustomDictionary[]>([]);
  const creatingRef = useRef(false);
  const [createForm] = Form.useForm<{ label: string; field_id: number }>();
  const loadCustomSets = useCallback(() => optionSetsApi.listCustom(), []);
  const { data: catalog, loading: loadingSets, error: setsError, reload: reloadSets } = useSettingsResource(loadCustomSets);
  useReferenceRefresh("optionSets", reloadSets, true);
  useReferenceRefresh("formFields", reloadSets);
  useEffect(() => {
    if (catalog) setCreatedSets((items) => items.filter((item) => !catalog.items.some((loaded) => loaded.field_id === item.field_id)));
  }, [catalog]);
  const customSets = [...(catalog?.items ?? []), ...createdSets.filter((item) => !catalog?.items.some((loaded) => loaded.field_id === item.field_id))];
  const availableFields = (catalog?.available_fields ?? []).filter((field) => !customSets.some((item) => item.field_id === field.field_id));
  const selectedCustom = customSets.find((item) => selected === `custom-${item.field_id}`);
  const canManageCustom = can("option-set.manage") && can("field-definition.manage");

  const createDictionary = async ({ label, field_id }: { label: string; field_id: number }) => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await optionSetsApi.createCustom(label.trim(), field_id);
      setCreatedSets((items) => [...items, created]);
      setSelected(`custom-${created.field_id}`);
      createForm.resetFields();
      setCreateOpen(false);
      await reloadSets();
    } catch (error) {
      setCreateError(normalizeError(error));
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  const deleteDictionary = async (fieldId: number) => {
    try {
      await optionSetsApi.deleteCustom(fieldId);
      setCreatedSets((items) => items.filter((item) => item.field_id !== fieldId));
      setSelected("order-types");
      await reloadSets();
    } catch (error) {
      setCreateError(normalizeError(error));
    }
  };

  const groups = CONFIG_CENTER_GROUP_ORDER.map((code) => ({
    code,
    label: CONFIG_GROUP_LABEL[code],
    items: SETTINGS_ITEMS.filter(
      (item) => item.group === code && (!item.permission || can(item.permission)),
    ),
  })).filter((group) => group.items.length > 0);

  const renderPanel = (key: string): ReactElement | null =>
    selectedCustom
      ? <>
          <Space wrap>
            <Typography.Text type="secondary">关联字段：{selectedCustom.scope_label} · {selectedCustom.field_label}</Typography.Text>
            {canManageCustom && <ConfirmButton
              permission="option-set.manage"
              danger
              title={`删除字典「${selectedCustom.label}」？`}
              description="删除后，关联的扩展字段及其选项仍会保留。"
              okText="删除"
              onConfirm={() => deleteDictionary(selectedCustom.field_id)}
            >删除字典</ConfirmButton>}
          </Space>
          <InlineError error={createError} />
          <OptionDictionarySection key={selectedCustom.field_id} code={`field-${selectedCustom.field_id}`} title={selectedCustom.label} description="维护关联扩展字段的选项。" linkedField={selectedCustom} />
        </>
      : PANEL_REGISTRY[key]?.(setSelected) ?? null;

  return (
    <div className="ui-stack config-center">
      <ErrorBanner error={setsError} onRetry={() => void reloadSets()} retrying={loadingSets} />
      <nav className="config-center__nav" aria-label="配置中心导航">
        {groups.map((group) => (
          <div key={group.code} className="config-center__group">
            <div className="config-center__group-title">{group.label}</div>
            {group.items.map((item) => (
              <button
                key={item.key}
                type="button"
                data-testid={`center-nav-${item.key}`}
                className={
                  "config-center__item" +
                  (selected === item.key ? " config-center__item--active" : "")
                }
                onClick={() => setSelected(item.key)}
              >
                <span>{item.label}</span>
                {item.readOnly ? <StatusTag status="DISABLED" label="只读" /> : null}
              </button>
            ))}
            {group.code === "MASTER" && customSets.map((item) => (
              <button
                key={item.field_id}
                type="button"
                data-testid={`center-nav-custom-${item.field_id}`}
                className={"config-center__item" + (selected === `custom-${item.field_id}` ? " config-center__item--active" : "")}
                onClick={() => { setCreateError(null); setSelected(`custom-${item.field_id}`); }}
              >
                {item.label}
              </button>
            ))}
            {group.code === "MASTER" && canManageCustom && <>
              <button type="button" className="config-center__item" disabled={loadingSets || Boolean(setsError) || availableFields.length === 0} onClick={() => { setCreateError(null); setCreateOpen(true); }}>
                新增字典
              </button>
              {!loadingSets && !setsError && availableFields.length === 0 && <Typography.Text type="secondary">请先添加自定义单选或多选字段</Typography.Text>}
            </>}
          </div>
        ))}
      </nav>
      <section className="config-center__content" data-testid="center-content">
        <Card className="glass" title={selectedCustom?.label ?? SETTINGS_ITEMS.find((i) => i.key === selected)?.label ?? "配置"}>
          {renderPanel(selected)}
        </Card>
      </section>
      <BusinessActionModal
        title="新增字典"
        size="compact"
        fieldCount={2}
        open={createOpen}
        confirmLoading={creating}
        cancelButtonProps={{ disabled: creating }}
        closable={!creating}
        maskClosable={!creating}
        onCancel={() => { if (!creating) setCreateOpen(false); }}
        onOk={() => void createForm.submit()}
        okText="创建"
      >
        <InlineError error={createError} />
        {createOpen && <BusinessRegistrationForm form={createForm} layout="vertical" onFinish={createDictionary}>
          <Form.Item name="label" label="字典名称" rules={[{ required: true, whitespace: true, message: "请输入字典名称" }]}>
            <Input maxLength={128} placeholder="请输入字典名称" />
          </Form.Item>
          <Form.Item name="field_id" label="关联扩展字段" rules={[{ required: true, message: "请选择关联的扩展字段" }]}>
            <Select showSearch optionFilterProp="label" placeholder="请选择自定义单选或多选字段" options={availableFields.map((field) => ({
              value: field.field_id,
              label: `${field.scope_label} · ${field.field_label}${field.is_active ? "" : "（已停用）"}`,
            }))} />
          </Form.Item>
        </BusinessRegistrationForm>}
      </BusinessActionModal>
    </div>
  );
}
