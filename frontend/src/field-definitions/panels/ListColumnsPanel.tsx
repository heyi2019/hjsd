/** 列表字段配置（设置页）：决定各列表**显示哪些列**、**列的先后顺序**、**列宽与固定列**，
 *  并可**新增自定义列**（绑定表单自定义字段，值从行数据扩展字段取）。
 *
 * 覆盖订单台账、库存中心、分期与回款、客户、返点、资金流水、报表、审计等现役列表。
 * 口径：
 *  - 内置列清单与中文名由后端注册表下发（app/lists/scopes.py），此处只改
 *    「显示/隐藏 + 顺序 + 列宽 + 固定列」；
 *  - 自定义列由管理员新增，绑定一个已启用的表单自定义字段（field_key）；列键统一
 *    `extra:{field_key}`，显示状态与内置列共用同一套保存逻辑；
 *  - 所有列（含身份列/操作列）均可隐藏与调序，无锁定约束；
 *  - 排序支持整行拖拽（HTML5 DnD，落在目标行位置），也保留上移/下移按钮；
 *  - 批量操作：勾选多列后一键显示/隐藏，一次整表提交；
 *  - 保存即生效，已打开的列表页会通过 refreshListColumns() 即时重排，无需刷新；
 *  - 恢复默认只清显示配置，自定义列定义保留；要删必须显式点「删除」。
 *  - 注意：部分列表（报表/审计等）的行数据不带扩展字段，新增的列会显示为空（"-"）。
 */
import { Input, InputNumber, Modal, Space, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listColumnsApi } from "../../shared/api/orders.api";
import type { ListColumnConfig, ListCustomFieldOption, ListScopeConfig } from "../../shared/api/types/forms";
import { normalizeError, type NormalizedError } from "../../shared/api/client";
import { refreshListColumns } from "../../shared/lib/listColumns";
import { useSettingsResource } from "../../shared/state/useSettingsResource";
import {
  ConfirmButton,
  DataTable,
  ErrorBanner,
  PermissionButton,
  PermissionGate,
  Select,
  StatusTag,
} from "../../shared/ui";
import { appMessage } from "../../shared/ui/appFeedback";
import "./ListColumnsPanel.css";

const FIXED_OPTIONS = [
  { value: "none", label: "不固定" },
  { value: "left", label: "固定左侧" },
  { value: "right", label: "固定右侧" },
];

/** 列宽最小/最大值：与后端 ListColumnItem 的 40~800 保持一致。 */
const WIDTH_MIN = 40;
const WIDTH_MAX = 800;

export function ListColumnsPanel() {
  const [scopes, setScopes] = useState<ListScopeConfig[]>([]);
  const [activeScope, setActiveScope] = useState<string>("");
  const [rows, setRows] = useState<ListColumnConfig[]>([]);
  const [mutationError, setMutationError] = useState<NormalizedError | null>(null);
  const [saving, setSaving] = useState(false);
  /** 列宽输入草稿：只在失焦/回车时提交，避免每敲一个数字打一次接口。 */
  const [widthDrafts, setWidthDrafts] = useState<Record<string, number | null>>({});
  // 新增自定义列弹窗状态
  const [addOpen, setAddOpen] = useState(false);
  const [fieldOptions, setFieldOptions] = useState<ListCustomFieldOption[]>([]);
  const [selectedField, setSelectedField] = useState<string | undefined>();
  const [customLabel, setCustomLabel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [removingKey, setRemovingKey] = useState<string | null>(null);
  /** 批量操作勾选：所有列（含身份列）均可勾选切换显示，与单行隐藏按钮同口径。 */
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  /** 拖拽排序：记录拖起行的列键，drop 到目标行时重排并整表提交。 */
  const dragKeyRef = useRef<string | null>(null);

  const applyScopes = useCallback((items: ListScopeConfig[], preferred?: string) => {
    setScopes(items);
    const target = preferred ?? items[0]?.code ?? "";
    setActiveScope(target);
    setRows(items.find((item) => item.code === target)?.columns ?? []);
  }, []);

  /** 一次保存成功后统一回填：行、scope 缓存、列宽草稿、通知所有已挂载列表重排。 */
  const applySaved = useCallback((saved: ListScopeConfig) => {
    setRows(saved.columns);
    setScopes((items) => items.map((item) => (item.code === saved.code ? saved : item)));
    setWidthDrafts({});
    refreshListColumns();
  }, []);

  const load = useCallback(() => listColumnsApi.all(), []);
  const { data: loadedScopes, loading, error: loadError, reload } = useSettingsResource(load);
  const error = mutationError ?? loadError;

  useEffect(() => {
    if (loadedScopes) applyScopes(loadedScopes, activeScope || undefined);
  }, [activeScope, applyScopes, loadedScopes]);

  const reloadPanel = useCallback(async () => {
    setMutationError(null);
    await reload();
  }, [reload]);

  const switchScope = (code: string) => {
    setActiveScope(code);
    setRows(scopes.find((item) => item.code === code)?.columns ?? []);
    setWidthDrafts({});
    setSelectedRowKeys([]);
  };

  /** 提交整表：顺序即数组顺序，sort_order 由后端按位置归一。 */
  const persist = async (next: ListColumnConfig[], successText: string) => {
    const previous = rows;
    setRows(next);
    setSaving(true);
    try {
      const saved = await listColumnsApi.save(
        activeScope,
        next.map((column, index) => ({
          key: column.key,
          is_visible: column.is_visible,
          sort_order: index * 10,
          width: column.width ?? null,
          fixed: column.fixed ?? null,
        })),
      );
      applySaved(saved);
      appMessage.success(successText);
    } catch (err) {
      setRows(previous);
      appMessage.error(normalizeError(err).message);
    } finally {
      setSaving(false);
    }
  };

  const toggle = (key: string, visible: boolean) =>
    persist(
      rows.map((column) => (column.key === key ? { ...column, is_visible: visible } : column)),
      visible ? "已设为显示" : "已隐藏该列",
    );

  /** 列宽：留空 = 自适应（存 null，表示不覆盖列定义宽度）。 */
  const setWidthDraft = (key: string, value: number | null) =>
    setWidthDrafts((prev) => ({ ...prev, [key]: value }));

  const commitWidth = (key: string, current: number | null | undefined) => {
    if (!(key in widthDrafts)) return;
    const draft = widthDrafts[key];
    setWidthDrafts((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    const normalized =
      draft === null ? null : Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Math.round(draft)));
    if ((normalized ?? null) === (current ?? null)) return;
    void persist(
      rows.map((column) => (column.key === key ? { ...column, width: normalized } : column)),
      normalized ? `列宽已设为 ${normalized} px` : "已改为自适应宽度",
    );
  };

  const setFixed = (key: string, fixed: string) =>
    persist(
      rows.map((column) =>
        column.key === key
          ? { ...column, fixed: fixed === "none" ? null : (fixed as "left" | "right") }
          : column,
      ),
      fixed === "none" ? "已取消固定" : "已固定该列",
    );

  const move = (index: number, offset: number) => {
    const target = index + offset;
    if (target < 0 || target >= rows.length) return;
    const next = [...rows];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    void persist(next, "顺序已更新");
  };

  /** 批量显示：一次整表提交，避免十几列逐列点。 */
  const showAll = () => {
    if (rows.every((column) => column.is_visible)) {
      appMessage.info("当前已是全部显示");
      return;
    }
    void persist(
      rows.map((column) => ({ ...column, is_visible: true })),
      "已显示全部列",
    );
  };

  /** 批量显示/隐藏所选列：一次整表提交；所有列（含身份列）均可批量切换，与单行操作同口径。 */
  const batchSetVisible = (visible: boolean) => {
    const targets = new Set(selectedRowKeys.map(String));
    if (!targets.size) return;
    setSelectedRowKeys([]);
    void persist(
      rows.map((column) => (targets.has(column.key) ? { ...column, is_visible: visible } : column)),
      visible ? "已显示所选列" : "已隐藏所选列",
    );
  };

  /** 恢复默认：清空该列表显示配置，回到注册表顺序与全列可见（自定义列定义保留）。 */
  const resetAll = async () => {
    const saved = await listColumnsApi.reset(activeScope);
    applySaved(saved);
    appMessage.success("已恢复默认列配置");
  };

  /** 打开新增弹窗时才拉候选字段（全部启用中的表单自定义字段）。 */
  const openAdd = async () => {
    setAddOpen(true);
    setSelectedField(undefined);
    setCustomLabel("");
    setFieldOptions([]);
    try {
      setFieldOptions(await listColumnsApi.customFields());
      setMutationError(null);
    } catch (err) {
      setMutationError(normalizeError(err));
    }
  };

  const submitAdd = async () => {
    if (!selectedField) {
      appMessage.info("请先选择一个字段");
      return;
    }
    setSubmitting(true);
    try {
      const saved = await listColumnsApi.addCustom(activeScope, selectedField, customLabel);
      applySaved(saved);
      setAddOpen(false);
      appMessage.success("自定义列已新增");
    } catch (err) {
      appMessage.error(normalizeError(err).message);
    } finally {
      setSubmitting(false);
    }
  };

  const removeCustom = async (key: string) => {
    setRemovingKey(key);
    try {
      const saved = await listColumnsApi.removeCustom(activeScope, key);
      applySaved(saved);
      appMessage.success("自定义列已删除");
    } catch (err) {
      appMessage.error(normalizeError(err).message);
    } finally {
      setRemovingKey(null);
    }
  };

  /** 候选字段按来源分组：表单作用域 + 「数据中已有值」（无字段定义的历史数据键）。 */
  const groupedFieldOptions = useMemo(() => {
    const groups = new Map<string, Array<{ value: string; label: string }>>();
    for (const item of fieldOptions) {
      const group =
        item.data_only
          ? "数据中已有值（按原值展示）"
          : `${item.scope_label}（${item.scope}）`;
      const suffix = item.data_only
        ? `${item.field_key}，${item.source_label ?? ""} ${item.row_count ?? 0} 行`
        : item.field_key;
      const list = groups.get(group) ?? [];
      list.push({ value: item.field_key, label: `${item.label}（${suffix}）` });
      groups.set(group, list);
    }
    return [...groups].map(([label, options]) => ({ label, options }));
  }, [fieldOptions]);
  const selectedOptionLabel = fieldOptions.find((item) => item.field_key === selectedField)?.label;

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
      title: "列宽",
      dataIndex: "width",
      width: 150,
      render: (width: number | null | undefined, row) => (
        <InputNumber
          className="ui-control-width-120"
          size="small"
          aria-label={`列宽_${row.key}`}
          min={WIDTH_MIN}
          max={WIDTH_MAX}
          step={20}
          placeholder="自适应"
          suffix="px"
          value={row.key in widthDrafts ? widthDrafts[row.key] : (width ?? null)}
          disabled={saving}
          onChange={(next) => setWidthDraft(row.key, typeof next === "number" ? next : null)}
          onBlur={() => commitWidth(row.key, width)}
          onPressEnter={() => commitWidth(row.key, width)}
        />
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
                  disabled={removingKey === row.key || saving}
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
        okButtonProps={{ disabled: !selectedField || submitting }}
        cancelText="取消"
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary">
          从候选里选一个字段，把它作为一列加到当前列表：可以是表单自定义字段（SELECT
          值会翻成中文），也可以是「数据中已有值」的历史字段（按原值展示）。
          列值取自行数据的扩展字段（form_extra / extra_values）；若该列表的行没有这个字段值，
          单元格会显示「-」。列名可自定义，新增后可照常隐藏、排序、调列宽与固定。
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
