/** T20：选项词典管理面板（设置页「选项词典」Tab）。
 *
 * 主从双表布局（2026-10-26 改造，对齐「游戏类型」列表式体验）：
 * - 左：词典主表（名称 / code / 分组 / 类型），点选某词典；
 * - 右：该词典的选项列表（值 + 文案 + 操作），底部内联新增表单。
 *
 * 两类词典语义不变：
 * - 纯字典（editable=true）：可增删改 value/label，保存写回后端；
 * - 后端死枚举（editable=false）：**值不可增删或改顺序**（受后端 CHECK / enums.py 约束），
 *   但展示文案可维护——改后全站筛选器与表格同步显示新文案（2026-10-26 裁决）。
 * 筛选器（库存/资金）从同一份数据读取，改这里即改全站筛选项与展示。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, Empty, Input, Select, Space, Spin, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { DeleteOutlined, PlusOutlined, SaveOutlined } from "@ant-design/icons";
import { optionSetsApi, type OptionItem, type OptionSet } from "../../shared/api/catalog";
import { clearOptionSetsCache } from "../../shared/lib/optionSets";

const GROUP_LABEL: Record<string, string> = {
  AUDIT: "审计",
  REPORT: "报表",
  INVENTORY: "库存",
  FUND: "资金",
  ORDER: "业务",
  CUSTOMER: "客户与合作方",
  INSTALLMENT: "分期与押金",
  IMPORT: "数据导入",
  POLICY: "经营规则",
  QUALITY: "质量",
  SYSTEM: "系统与人员",
  FIELD: "字段与实体",
  GENERAL: "通用",
};

function EditableOptionSet({ set }: { set: OptionSet }) {
  const keySeq = useRef(0);
  const nextKey = () => ++keySeq.current;
  const [draft, setDraft] = useState<Array<OptionItem & { _k: number }>>(() =>
    (set.options ?? []).map((o) => ({ ...o, _k: nextKey() })),
  );
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(set.options ?? []);

  const update = (idx: number, key: keyof OptionItem, value: string) =>
    setDraft((prev) => prev.map((row, i) => (i === idx ? { ...row, [key]: value } : row)));
  const remove = (idx: number) => setDraft((prev) => prev.filter((_, i) => i !== idx));
  const add = () => setDraft((prev) => [...prev, { value: "", label: "", _k: nextKey() }]);

  const save = async () => {
    if (draft.some((r) => !r.value.trim())) {
      message.warning("选项 value 不能为空");
      return;
    }
    const values = draft.map((r) => r.value.trim());
    if (new Set(values).size !== values.length) {
      message.warning("选项 value 重复");
      return;
    }
    setSaving(true);
    try {
      await optionSetsApi.update(set.code, {
        options: draft.map((r) => ({ value: r.value.trim(), label: r.label.trim() })),
      });
      clearOptionSetsCache();
      message.success("已保存");
    } catch (err) {
      message.error((err as { message?: string })?.message ?? "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      className="glass"
      size="small"
      title={
        <Space>
          <span>{set.label}</span>
          <Tag color="blue">{set.code}</Tag>
          <Tag color="green">可编辑</Tag>
        </Space>
      }
      extra={
        <Space>
          <Button size="small" icon={<PlusOutlined />} onClick={add}>添加选项</Button>
          <Button size="small" type="primary" icon={<SaveOutlined />} loading={saving} disabled={!dirty} onClick={save}>
            保存
          </Button>
        </Space>
      }
    >
      {set.description ? <Typography.Paragraph type="secondary">{set.description}</Typography.Paragraph> : null}
      {draft.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无选项" />
      ) : (
        <Table<OptionItem & { _k: number }>
          rowKey={(r) => String(r._k)}
          size="small"
          pagination={false}
          dataSource={draft}
          columns={[
            {
              title: "值 (value)",
              dataIndex: "value",
              render: (_v: string, row, idx) => (
                <Input
                  aria-label={`${set.label} 第 ${idx + 1} 行 value`}
                  value={row.value}
                  onChange={(e) => update(idx, "value", e.target.value)}
                />
              ),
            },
            {
              title: "展示名 (label)",
              dataIndex: "label",
              render: (_v: string, row, idx) => (
                <Input
                  aria-label={`${set.label} 第 ${idx + 1} 行 label`}
                  value={row.label}
                  onChange={(e) => update(idx, "label", e.target.value)}
                />
              ),
            },
            {
              title: "操作",
              key: "op",
              width: 64,
              render: (_v: unknown, _row, idx) => (
                <Button danger size="small" icon={<DeleteOutlined />} aria-label={`删除第 ${idx + 1} 行`} onClick={() => remove(idx)} />
              ),
            },
          ]}
        />
      )}
    </Card>
  );
}

/** 死枚举卡片：值锁死，只让改展示文案。
 *  保存时把「原 value + 新 label」整份回传，后端校验值序列全等后才落库；
 *  值集合若被改动会被后端拒绝（业务语义受 CHECK 保护，不会静默漂移）。 */
function ReadOnlyOptionSet({ set, onSaved }: { set: OptionSet; onSaved: () => void }) {
  const [draft, setDraft] = useState<string[]>((set.options ?? []).map((opt) => opt.label));
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify((set.options ?? []).map((opt) => opt.label));

  const save = async () => {
    if (draft.some((label) => !label.trim())) {
      message.warning("展示文案不能为空");
      return;
    }
    setSaving(true);
    try {
      await optionSetsApi.update(set.code, {
        options: (set.options ?? []).map((opt, idx) => ({ value: opt.value, label: draft[idx].trim() })),
      });
      clearOptionSetsCache();
      message.success("展示文案已保存，全站同步生效");
      onSaved();
    } catch (err) {
      message.error((err as { message?: string })?.message ?? "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      className="glass"
      size="small"
      title={
        <Space>
          <span>{set.label}</span>
          <Tag color="default">{set.code}</Tag>
          <Tag color="red">值只读 · 文案可改</Tag>
        </Space>
      }
      extra={
        <Button size="small" type="primary" icon={<SaveOutlined />} loading={saving} disabled={!dirty} onClick={save}>
          保存文案
        </Button>
      }
    >
      {set.description ? <Typography.Paragraph type="secondary">{set.description}</Typography.Paragraph> : null}
      <Table<{ value: string; label: string }>
        rowKey={(r) => r.value}
        size="small"
        pagination={false}
        dataSource={(set.options ?? []).map((opt, idx) => ({ value: opt.value, label: draft[idx] ?? "" }))}
        columns={[
          { title: "值 (只读)", dataIndex: "value", render: (v: string) => <Tag>{v}</Tag> },
          {
            title: "展示文案",
            dataIndex: "label",
            render: (_v: string, row, idx) => (
              <Input
                aria-label={`${set.label} ${row.value} 展示文案`}
                value={row.label}
                onChange={(e) => setDraft((prev) => prev.map((l, i) => (i === idx ? e.target.value : l)))}
                className="ui-control-width-200"
              />
            ),
          },
        ]}
      />
    </Card>
  );
}

export function OptionSetsPanel() {
  const [sets, setSets] = useState<OptionSet[] | null>(null);
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [groupFilter, setGroupFilter] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let active = true;
    optionSetsApi
      .list()
      .then((res) => {
        if (active) setSets(res.items);
      })
      .catch((err) => {
        if (active) setError((err as { message?: string })?.message ?? "加载失败");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => load(), [load]);

  // 首次加载默认选中第一个，避免右侧空白
  useEffect(() => {
    if (sets && selectedCode === null && sets.length > 0) {
      setSelectedCode(sets[0].code);
    }
  }, [sets, selectedCode]);

  const groups = useMemo(
    () => Array.from(new Set((sets ?? []).map((s) => s.group))).sort(),
    [sets],
  );
  const filtered = useMemo(
    () => (groupFilter ? (sets ?? []).filter((s) => s.group === groupFilter) : (sets ?? [])),
    [sets, groupFilter],
  );
  const selected = useMemo(
    () => (sets ?? []).find((s) => s.code === selectedCode) ?? null,
    [sets, selectedCode],
  );

  const masterColumns: ColumnsType<OptionSet> = [
    { title: "名称", dataIndex: "label" },
    { title: "code", dataIndex: "code", render: (v: string) => <Tag color="default">{v}</Tag> },
    { title: "分组", dataIndex: "group", render: (g: string) => GROUP_LABEL[g] ?? g },
    {
      title: "类型",
      dataIndex: "editable",
      width: 132,
      render: (ed: boolean) =>
        ed ? <Tag color="green">可编辑</Tag> : <Tag color="red">值只读 · 文案可改</Tag>,
    },
  ];

  if (error) return <Typography.Text type="danger">{error}</Typography.Text>;
  if (sets === null) return <Spin />;
  if (sets.length === 0) return <Empty description="暂无选项词典" />;

  return (
    <div className="ui-stack">
      <Typography.Paragraph type="secondary">
        选项词典是库存、资金等页面筛选项与状态展示的单一来源。左侧选择词典，右侧维护其选项：纯字典可自由增删；带「值只读 ·
        文案可改」标记的由后端约束值集合，只能维护展示文案，改后全站表格与筛选器同步。
      </Typography.Paragraph>
      <Space className="ui-form-spaced" wrap>
        <Select
          allowClear
          placeholder="按分组筛选"
          style={{ width: 200 }}
          value={groupFilter}
          onChange={(v) => setGroupFilter(v)}
          options={groups.map((g) => ({ value: g, label: GROUP_LABEL[g] ?? g }))}
        />
      </Space>
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
        <Card
          className="glass"
          size="small"
          title="词典列表"
          data-testid="option-sets-master"
          style={{ width: 380, flex: "none" }}
        >
          <Table<OptionSet>
            rowKey="code"
            size="small"
            pagination={false}
            scroll={{ y: 480 }}
            columns={masterColumns}
            dataSource={filtered}
            rowClassName={(r) => (r.code === selectedCode ? "row-selected" : "")}
            onRow={(r) => ({ onClick: () => setSelectedCode(r.code), style: { cursor: "pointer" } })}
          />
        </Card>
        <div data-testid="option-sets-detail" style={{ flex: 1, minWidth: 360 }}>
          {selected ? (
            selected.editable ? (
              <EditableOptionSet key={selected.code} set={selected} />
            ) : (
              <ReadOnlyOptionSet key={selected.code} set={selected} onSaved={load} />
            )
          ) : (
            <Empty description="请选择左侧词典" />
          )}
        </div>
      </div>
    </div>
  );
}
