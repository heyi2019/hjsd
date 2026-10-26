/** T20：选项词典管理面板（设置页「选项词典」Tab）。
 *
 * - 纯字典（editable=true）：可增删改 value/label，保存写回后端；
 * - 后端死枚举（editable=false）：**值不可增删或改顺序**（受后端 CHECK / enums.py 约束），
 *   但展示文案可维护——改后全站筛选器与表格同步显示新文案（2026-10-26 裁决）。
 * 筛选器（库存/资金）从同一份数据读取，改这里即改全站筛选项与展示。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Card, Empty, Input, Space, Spin, Tag, Typography, message } from "antd";
import { DeleteOutlined, PlusOutlined, SaveOutlined } from "@ant-design/icons";
import { optionSetsApi, type OptionItem, type OptionSet } from "../../shared/api/catalog";
import { clearOptionSetsCache } from "../../shared/lib/optionSets";

const GROUP_LABEL: Record<string, string> = {
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
  const [draft, setDraft] = useState<OptionItem[]>(set.options ?? []);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(set.options ?? []);

  const update = (idx: number, key: keyof OptionItem, value: string) =>
    setDraft((prev) => prev.map((row, i) => (i === idx ? { ...row, [key]: value } : row)));
  const remove = (idx: number) => setDraft((prev) => prev.filter((_, i) => i !== idx));
  const add = () => setDraft((prev) => [...prev, { value: "", label: "" }]);

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
      await optionSetsApi.update(set.code, { options: draft.map((r) => ({ value: r.value.trim(), label: r.label.trim() })) });
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
        <Space direction="vertical" style={{ width: "100%" }} size={8}>
          {draft.map((row, idx) => (
            <Space key={idx} style={{ width: "100%" }}>
              <Input
                placeholder="value（后端枚举码/字典键）"
                value={row.value}
                onChange={(e) => update(idx, "value", e.target.value)}
                style={{ width: 240 }}
              />
              <Input
                placeholder="label（展示名）"
                value={row.label}
                onChange={(e) => update(idx, "label", e.target.value)}
                style={{ width: 240 }}
              />
              <Button danger size="small" icon={<DeleteOutlined />} onClick={() => remove(idx)} />
            </Space>
          ))}
        </Space>
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
      <Space direction="vertical" size={8}>
        {(set.options ?? []).map((opt, idx) => (
          <Space key={opt.value} wrap>
            <Tag>{opt.value}</Tag>
            <Input
              aria-label={`${set.label} ${opt.value} 展示文案`}
              value={draft[idx] ?? ""}
              onChange={(e) => setDraft((prev) => prev.map((v, i) => (i === idx ? e.target.value : v)))}
              className="ui-control-width-200"
            />
          </Space>
        ))}
      </Space>
    </Card>
  );
}

export function OptionSetsPanel() {
  const [sets, setSets] = useState<OptionSet[] | null>(null);
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

  const grouped = useMemo(() => {
    const map = new Map<string, OptionSet[]>();
    for (const s of sets ?? []) {
      const arr = map.get(s.group) ?? [];
      arr.push(s);
      map.set(s.group, arr);
    }
    return map;
  }, [sets]);

  if (error) return <Typography.Text type="danger">{error}</Typography.Text>;
  if (sets === null) return <Spin />;

  if (sets.length === 0) return <Empty description="暂无选项词典" />;

  return (
    <div className="ui-stack">
      <Typography.Paragraph type="secondary">
        选项词典是库存、资金等页面筛选项与状态展示的单一来源。纯字典可自由增删；带「值只读 · 文案可改」标记的由后端约束值集合，只能维护展示文案，改后全站表格与筛选器同步。
      </Typography.Paragraph>
      {[...grouped.entries()].map(([group, items]) => (
        <Card key={group} type="inner" title={GROUP_LABEL[group] ?? group}>
          <Space direction="vertical" style={{ width: "100%" }} size={12}>
            {items.map((set) =>
              set.editable ? (
                <EditableOptionSet key={set.code} set={set} />
              ) : (
                <ReadOnlyOptionSet key={set.code} set={set} onSaved={load} />
              ),
            )}
          </Space>
        </Card>
      ))}
    </div>
  );
}
