
/** 表单字段配置面板：按表单作用域（33 个业务表单）配置字段的
 *  新增、删除、必填态（必填/条件必填/选填）、停用/启用。字段可配置必填态与启用态；
 *  仅自定义字段可删除（预置字段受保护）。 */
import { Segmented, Typography } from "antd";
import type { OrderFormField } from "../../shared/api/types/forms";
import { DataTable, ErrorBanner, Select } from "../../shared/ui";
import "./SettingsSubpanel.css";
import "./OrderFormFieldsPanel.css";
import { useOrderFormFieldsPanelController } from "./useOrderFormFieldsPanelController";
import { SectionManagementCard } from "./OrderFormFieldsPanel.sections";
import { ORDER_SCOPE_CODES, ORDER_SCOPE_OPTIONS, type OrderFormFieldsPanelProps } from "./OrderFormFieldsPanel.fragments";
export type { OrderFormFieldsPanelProps };

export function OrderFormFieldsPanel({
  initialScope,
  onConfigureGameTypes,
  onConfigureIntermediaryPlatforms,
  onConfigurePools,
  onConfigurePartySources,
}: OrderFormFieldsPanelProps = {}) {
  const controller = useOrderFormFieldsPanelController({
    initialScope,
    onConfigureGameTypes,
    onConfigureIntermediaryPlatforms,
    onConfigurePools,
    onConfigurePartySources,
  });
  const {
    activeFilter,
    activeType,
    columns,
    changeScope,
    editingId,
    editorForm,
    error,
    groupedScopeOptions,
    load,
    loadSectionLabels,
    orderedSectionOptions,
    sectionFilter,
    sectionError,
    sectionLoading,
    setActiveFilter,
    setSectionFilter,
    visibleRows,
  } = controller;

  return (
    <section className="order-form-fields-panel">
      <ErrorBanner error={error} onRetry={() => void load(activeType)} />
      <ErrorBanner error={sectionError} onRetry={() => void loadSectionLabels(activeType)} retrying={sectionLoading} />
      <div className="settings-subpanel order-form-fields__container">
        <div className="order-form-fields__toolbar">
          <Typography.Text strong>表单</Typography.Text>
          <Select
            className="ui-control-width-260"
            value={activeType}
            onChange={changeScope}
            options={groupedScopeOptions}
            optionFilterProp="label"
            showSearch
          />
          <Typography.Text strong>建单快捷入口</Typography.Text>
          <Segmented
            aria-label="建单表快捷入口"
            options={ORDER_SCOPE_OPTIONS}
            value={ORDER_SCOPE_CODES.has(activeType) ? activeType : undefined}
            onChange={(value) => changeScope(String(value))}
          />
          <Typography.Text strong>板块筛选</Typography.Text>
          <Select
            aria-label="字段板块筛选"
            value={sectionFilter}
            onChange={setSectionFilter}
            className="ui-control-width-180"
            options={[{ value: "ALL", label: "全部板块" }, ...orderedSectionOptions]}
            popupClassName="order-form-section-filter-pop"
          />
          <Typography.Text strong>状态筛选</Typography.Text>
          <Select
            aria-label="字段启用状态筛选"
            value={activeFilter}
            onChange={setActiveFilter}
            className="ui-control-width-140"
            options={[
              { value: "ALL", label: "全部状态" },
              { value: "ACTIVE", label: "已启用" },
              { value: "INACTIVE", label: "已停用" },
            ]}
          />
        </div>
        <DataTable<OrderFormField>
          columns={columns}
          rows={visibleRows}
          page={1}
          pageSize={Math.max(visibleRows.length, 10)}
          total={visibleRows.length}
          emptyText="该表单暂无字段配置"
          onPageChange={() => undefined}
          // 7 列（字段键/标签/类型/必填/选项/启用/操作）在窄容器内会被压到换行，
          // 统一按内容宽度渲染，由 .ui-table-wrap 的 overflow:auto 承担左右滑动。
          expandable={{
            expandedRowKeys: editingId === null ? [] : [String(editingId)],
            showExpandColumn: false,
            expandedRowRender: (row) => <div aria-label={`编辑区${row.label}`} className="order-form-fields__edit-container">{editorForm}</div>,
          }}
        />
      </div>
      {editingId === null && !groupedScopeOptions.find((group) => group.label === "系统设置")?.options.some((option) => option.value === activeType) ? (
        <div className="settings-subpanel order-form-fields__container order-form-fields__create-container">
          <Typography.Title level={5}>新增自定义字段</Typography.Title>
          {editorForm}
        </div>
      ) : null}
      <SectionManagementCard controller={controller} />
    </section>
  );
}
