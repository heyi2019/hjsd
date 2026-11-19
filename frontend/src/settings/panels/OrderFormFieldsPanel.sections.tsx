import { Card, Input, Space, Typography } from "antd";
import { DataTable, PermissionButton, PermissionGate } from "../../shared/ui";
import type { SectionManagementRow } from "./OrderFormFieldsPanel.fragments";
import type { OrderFormFieldsPanelController } from "./useOrderFormFieldsPanelController";

/** 板块管理卡片：板块清单 + 改键改名 + 新增板块。 */
export function SectionManagementCard({ controller }: { controller: OrderFormFieldsPanelController }) {
  const {
    addingSection,
    beginAddSection,
    editSection,
    editingSectionValue,
    saveSection,
    sectionDraft,
    sectionKeyInputRef,
    sectionLabelInputRef,
    sectionManagementRows,
    setAddingSection,
    setEditingSectionValue,
    setSectionDraft,
    setSectionFilter,
  } = controller;

  return (
      <Card className="glass order-form-section-management" title="板块管理">
        <div data-testid="form-section-management">
          <DataTable<SectionManagementRow>
            className="order-form-section-management__table"
            columns={[
              { title: "板块键", dataIndex: "value", render: (value: string) => <Typography.Text code>{value}</Typography.Text>, width: 150 },
              {
                title: "板块名称",
                dataIndex: "label",
                render: (value: string) => value,
              },
              { title: "字段数量", dataIndex: "count", render: (value: number) => `${value} 个字段`, width: 110 },
              { title: "排序", render: (_value, row) => row.index + 1, width: 72 },
              {
                title: "操作",
                render: (_value, row) => (
                  <PermissionGate permission="field-definition.manage">
                    <Space size={2}>
                      <PermissionButton permission="field-definition.manage" size="small" aria-label={`编辑${row.label}`} onClick={() => editSection(row.value)}>编辑</PermissionButton>
                      <PermissionButton permission="field-definition.manage" size="small" onClick={() => setSectionFilter(row.value)}>查看字段</PermissionButton>
                    </Space>
                  </PermissionGate>
                ),
              },
            ]}
            rows={sectionManagementRows}
            page={1}
            pageSize={sectionManagementRows.length}
            total={sectionManagementRows.length}
            onPageChange={() => undefined}
            pagination={false}
            rowKey="value"
          />
        </div>
        <PermissionGate permission="field-definition.manage">
          {editingSectionValue || addingSection ? (
            <div className="ui-form-spaced order-form-section-management__editor">
              <label>
                板块键
                <Input
                  aria-label="板块键"
                  key={`section-key-${editingSectionValue ?? "new"}`}
                  ref={sectionKeyInputRef}
                  defaultValue={sectionDraft.value}
                  className="ui-control-width-180"
                  placeholder="按小写字母和下划线填写"
                />
              </label>
              <label>
                板块名称
                <Input
                  aria-label="板块名称"
                  key={`section-label-${editingSectionValue ?? "new"}`}
                  ref={sectionLabelInputRef}
                  defaultValue={sectionDraft.label}
                  className="ui-control-width-220"
                />
              </label>
              <PermissionButton permission="field-definition.manage" type="primary" htmlType="button" onClick={() => void saveSection()}>保存板块</PermissionButton>
              <PermissionButton permission="field-definition.manage" htmlType="button" onClick={() => { setEditingSectionValue(null); setAddingSection(false); setSectionDraft({ value: "", label: "" }); }}>取消编辑</PermissionButton>
            </div>
          ) : null}
        </PermissionGate>
        <PermissionGate permission="field-definition.manage">
          <PermissionButton permission="field-definition.manage" type="primary" htmlType="button" onClick={beginAddSection}>新增板块</PermissionButton>
        </PermissionGate>
      </Card>
  );
}
