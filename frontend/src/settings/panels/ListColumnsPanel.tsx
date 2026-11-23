/** 列表字段配置（设置页）：决定各列表**显示哪些列**、**列的先后顺序**与**固定列**，
 *  并可**新增自定义列**（绑定表单自定义字段，值从行数据扩展字段取）。
 *
 * 覆盖订单台账、库存中心、分期与回款、客户、返点、资金流水、报表、审计等现役列表。
 * 口径：
 *  - 内置列清单与中文名由后端注册表下发（app/lists/scopes.py），此处只改
 *    「显示/隐藏 + 顺序 + 固定列」；
 *  - 自定义列由管理员新增，绑定一个已启用的表单自定义字段（field_key）；列键统一
 *    `extra:{field_key}`，显示状态与内置列共用同一套保存逻辑；
 *  - 所有列（含身份列/操作列）均可隐藏与调序，无锁定约束；
 *  - 排序支持整行拖拽（HTML5 DnD，落在目标行位置），也保留上移/下移按钮；
 *  - 批量操作：勾选多列后一键显示/隐藏，一次整表提交；
 *  - 保存接口返回的配置直接同步已打开的列表页，无需刷新；
 *  - 恢复默认只清显示配置，自定义列定义保留；要删必须显式点「删除」。
 *  - 注意：部分列表（报表/审计等）的行数据不带扩展字段，新增的列会显示为空（"-"）。
 */
import { Input, Modal, Space, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { ListColumnConfig } from "../../shared/api/types/forms";
import {
  ConfirmButton,
  DataTable,
  ErrorBanner,
  PermissionButton,
  PermissionGate,
  Select,
  StatusTag,
} from "../../shared/ui";
import "./ListColumnsPanel.css";
import { useListColumnsController } from "./useListColumnsController";

const FIXED_OPTIONS = [
  { value: "none", label: "不固定" },
  { value: "left", label: "固定左侧" },
  { value: "right", label: "固定右侧" },
];

export function ListColumnsPanel() {
  const {
    scopes, activeScope, rows, error, saving, addOpen, selectedField, customLabel,
    selectedRowKeys, setSelectedRowKeys, loading, dragKeyRef,
    setAddOpen, setSelectedField, setCustomLabel,
    reloadPanel, switchScope, persist, toggle, setFixed, move, showAll,
    batchSetVisible, resetAll, openAdd, submitAdd, removeCustom,
    groupedFieldOptions, selectedOptionLabel,
  } = useListColumnsController();

  const columns: ColumnsType<ListColumnConfig> = [
    {
      title: "顺序",
      key: "position",
      width: 64,
      render: (_v, row) => rows.findIndex((item) => item.key === row.key) + 1,
    },
    {
      title: "列名",
      dataIndex: "label",
      render: (label: string, row) => (
        <Space size={4}>
          <span>{label}</span>
          {row.custom ? <StatusTag status="ACTIVE" label="自定义" /> : null}
        </Space>
      ),
    },
    {
      title: "字段键",
      dataIndex: "key",
      render: (v: string, row) => (
        <Typography.Text type="secondary">{row.custom ? row.source_key : v}</Typography.Text>
      ),
    },
    {
      title: "显示",
      dataIndex: "is_visible",
      width: 120,
      render: (visible: boolean) => (
        <Space size={4}>
          <StatusTag status={visible ? "ACTIVE" : "DISABLED"} label={visible ? "显示" : "已隐藏"} />
        </Space>
      ),
    },
    {
      title: "固定",
      dataIndex: "fixed",
      width: 130,
      render: (fixed: "left" | "right" | null | undefined, row) => (
        <Select
          className="ui-control-width-120"
          size="small"
          aria-label={`固定_${row.key}`}
          value={fixed ?? "none"}
          options={FIXED_OPTIONS}
          disabled={saving}
          onChange={(next) => setFixed(row.key, String(next))}
        />
      ),
    },
    {
      title: "操作",
      key: "actions",
      width: 280,
      render: (_v, row) => {
        const index = rows.findIndex((item) => item.key === row.key);
        return (
          <PermissionGate permission="field-definition.manage">
            <Space size={2} wrap>
              <PermissionButton
                permission="field-definition.manage"
                size="small"
                aria-label={`显示_${row.key}`}
                disabled={saving}
                onClick={() => void toggle(row.key, !row.is_visible)}
              >
                {row.is_visible ? "隐藏" : "显示"}
              </PermissionButton>
              <PermissionButton
                permission="field-definition.manage"
                size="small"
                aria-label={`上移_${row.key}`}
                disabled={index <= 0 || saving}
                onClick={() => move(index, -1)}
              >
                上移
              </PermissionButton>
              <PermissionButton
                permission="field-definition.manage"
                size="small"
                aria-label={`下移_${row.key}`}
                disabled={index < 0 || index >= rows.length - 1 || saving}
                onClick={() => move(index, 1)}
              >
                下移
              </PermissionButton>
              {row.custom ? (
                <ConfirmButton
                  permission="field-definition.manage"
                  size="small"
                  danger
                  title={`删除自定义列「${row.label}」`}
                  description="删除后该列从所有列表页消失；行数据里的字段值仍保留。"
                  okText="确认删除"
                  aria-label={`删除_${row.key}`}
                  disabled={saving}
                  onConfirm={() => removeCustom(row.key)}
                >
                  删除
                </ConfirmButton>
              ) : null}
            </Space>
          </PermissionGate>
        );
      },
    },
  ];

  return (
    <section className="ui-stack list-columns-panel">
      <ErrorBanner error={error} onRetry={() => void reloadPanel()} retrying={loading} />

      <div className="list-columns__toolbar" data-testid="list-columns-master">
        <Typography.Text strong>列表</Typography.Text>
        <Select
          className="ui-control-width-260"
          value={activeScope || undefined}
          onChange={switchScope}
          options={scopes.map((item) => ({ value: item.code, label: item.label }))}
          placeholder="选择列表"
        />
        <PermissionButton
          permission="field-definition.manage"
          size="small"
          aria-label="新增列"
          disabled={saving}
          onClick={() => void openAdd()}
        >
          新增列
        </PermissionButton>
        <PermissionButton
          permission="field-definition.manage"
          size="small"
          aria-label="显示全部列"
          disabled={saving}
          onClick={showAll}
        >
          全部显示
        </PermissionButton>
        <PermissionButton
          permission="field-definition.manage"
          size="small"
          aria-label="显示所选列"
          disabled={saving || selectedRowKeys.length === 0}
          onClick={() => batchSetVisible(true)}
        >
          显示所选
        </PermissionButton>
        <PermissionButton
          permission="field-definition.manage"
          size="small"
          aria-label="隐藏所选列"
          disabled={saving || selectedRowKeys.length === 0}
          onClick={() => batchSetVisible(false)}
        >
          隐藏所选
        </PermissionButton>
        <ConfirmButton
          permission="field-definition.manage"
          title="恢复默认列配置"
          description="清空该列表的全部显示配置，回到初始顺序与全列显示（自定义列定义保留）。此操作不可撤销，会记入审计。"
          okText="确认恢复"
          danger
          aria-label="恢复默认列配置"
          disabled={saving}
          onConfirm={resetAll}
        >
          恢复默认
        </ConfirmButton>
      </div>

      <div className="list-columns__detail" data-testid="list-columns-detail">
        <DataTable<ListColumnConfig>
          columns={columns}
          rows={rows}
          rowKey="key"
          page={1}
          pageSize={Math.max(rows.length, 10)}
          total={rows.length}
          loading={loading || saving}
          emptyText="该列表暂无可配置的列"
          onPageChange={() => undefined}
          rowSelection={{
            selectedRowKeys,
            onChange: (keys) => setSelectedRowKeys(keys),
            // 所有列（含身份列/操作列）均可勾选批量切换显示，与单行隐藏按钮同口径（#15）。
            getCheckboxProps: () => ({ disabled: saving }),
          }}
          /** 整行拖拽排序：拖起记录来源键，drop 到目标行位置后整表重排提交。 */
          onRow={(row) => ({
            draggable: true,
            onDragStart: () => {
              dragKeyRef.current = row.key;
            },
            onDragOver: (event) => event.preventDefault(),
            onDrop: () => {
              const from = dragKeyRef.current;
              dragKeyRef.current = null;
              if (!from || from === row.key) return;
              const fromIndex = rows.findIndex((column) => column.key === from);
              const toIndex = rows.findIndex((column) => column.key === row.key);
              if (fromIndex < 0 || toIndex < 0) return;
              const next = [...rows];
              const [moved] = next.splice(fromIndex, 1);
              next.splice(toIndex, 0, moved);
              void persist(next, "顺序已更新");
            },
            onDragEnd: () => {
              dragKeyRef.current = null;
            },
          })}
        />
      </div>

      <Modal
        title="新增自定义列"
        open={addOpen}
        onCancel={() => setAddOpen(false)}
        onOk={() => void submitAdd()}
        okText="确认新增"
        okButtonProps={{ disabled: !selectedField || saving }}
        cancelText="取消"
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary">
          从候选里选一个字段，把它作为一列加到当前列表：可以是表单自定义字段（SELECT
          值会翻成中文），也可以是「数据中已有值」的历史字段（按原值展示）。
          列值取自行数据的扩展字段（form_extra / extra_values）；若该列表的行没有这个字段值，
          单元格会显示「-」。列名可自定义，新增后可照常隐藏、排序与固定。
        </Typography.Paragraph>
        <Space direction="vertical" className="ui-control-full">
          <Typography.Text strong>来源字段</Typography.Text>
          <Select
            aria-label="自定义列来源字段"
            showSearch
            optionFilterProp="label"
            placeholder="选择字段（表单自定义 / 数据中已有值）"
            value={selectedField}
            onChange={(value) => setSelectedField(String(value))}
            options={groupedFieldOptions}
            className="ui-control-full"
            popupClassName="list-column-field-pop"
          />
          <Typography.Text strong>列名（可留空，默认用字段标签）</Typography.Text>
          <Input
            aria-label="自定义列列名"
            value={customLabel}
            maxLength={64}
            placeholder={selectedOptionLabel ?? "如：会员等级"}
            onChange={(event) => setCustomLabel(event.target.value)}
          />
        </Space>
      </Modal>
    </section>
  );

}
