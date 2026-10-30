import { appMessage, appModal } from "../shared/ui/appFeedback";
/** 工作室收支：在指定资金池上快速登记日常开销与零星收入（房租 / 日用 / 水电 …）。
 *
 * 设计约束（刻意不新增后端表）：
 * - **入账复用「新增独立流水」**：支出 = OUT / BUSINESS_OUT / OPERATING_EXPENSE，
 *   收入 = IN / BUSINESS_IN / SELF_REVENUE，科目落在 `category`。只存在一套入账口径。
 * - **不走审核态**：提交后自动补审核，登记即入账（后端独立流水固定先 PENDING，
 *   此处紧接 `approve` 完成闭环；若自动审核失败会提示去流水页手动审核）。
 * - **承载资金池可勾选**：配置落在选项词典 `STUDIO_EXPENSE_POOL`（value=池 code），
 *   科目字典落在 `STUDIO_EXPENSE_ITEM`；首次保存时自动补建词典，服务端存储 ⇒ 全员同步。
 */
import { Card, Form, Input, Space, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { CfgItem, CustomFieldSection, FieldConfigScope } from "../orders/ConfigurableField";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  cashflowsApi,
  optionSetsApi,
  type Cashflow,
  type OptionItem,
  type Pool,
} from "../shared/api/catalog";
import { normalizeError, type NormalizedError } from "../shared/api/client";
import { today } from "../shared/lib/format";
import { clearOptionSetsCache } from "../shared/lib/optionSets";
import { requiredMoneyRules } from "../shared/lib/validators";
import {
  ConfirmButton,
  DataTable,
  BusinessActionModal,
  BusinessForm,
  ErrorBanner,
  InlineError,
  MoneyInput,
  MoneyText,
  PermissionButton,
  Select,
  StatRow,
  StatusTag,
  CompactActions,
} from "../shared/ui";
import { useAsyncAction } from "../shared/hooks/useAsyncAction";

/** 承载资金池词典：value 存池 code，池改名不影响配置。 */
const POOL_SET_CODE = "STUDIO_EXPENSE_POOL";
const POOL_SET_LABEL = "工作室收支承载资金池";
/** 费用科目词典。 */
const ITEM_SET_CODE = "STUDIO_EXPENSE_ITEM";
const ITEM_SET_LABEL = "工作室支出费用科目";

const DEFAULT_EXPENSE_ITEMS: OptionItem[] = [
  { value: "房租", label: "房租" },
  { value: "日用", label: "日用" },
  { value: "水电", label: "水电" },
  { value: "物业", label: "物业" },
  { value: "其他", label: "其他" },
];

const INCOME_ITEMS: OptionItem[] = [
  { value: "货款", label: "货款" },
  { value: "退款", label: "退款" },
  { value: "其他", label: "其他" },
];

/** 单次拉取上限：按日期区间查询，200 条覆盖月度收支足够。 */
const FETCH_LIMIT = 200;

async function readOptionSet(code: string): Promise<OptionItem[] | null> {
  try {
    const set = await optionSetsApi.get(code);
    return set.options ?? null;
  } catch {
    // 词典尚未创建（首次使用）：调用方按 null 回落处理，不让整页崩。
    return null;
  }
}

async function writeOptionSet(
  code: string,
  label: string,
  options: OptionItem[],
): Promise<void> {
  const payload = { code, label, group: "FUND", editable: true, options };
  try {
    await optionSetsApi.update(code, payload);
  } catch {
    // 首次保存：先补建词典（写权限同为 option-set.manage）。
    await optionSetsApi.create(payload);
  }
  clearOptionSetsCache();
}

export function StudioExpensePanel({ pools }: { pools: Pool[] }) {
  const [flows, setFlows] = useState<Cashflow[]>([]);
  const [poolCodes, setPoolCodes] = useState<string[]>([]);
  const [expenseItems, setExpenseItems] = useState<OptionItem[]>(DEFAULT_EXPENSE_ITEMS);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<NormalizedError | null>(null);

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [category, setCategory] = useState<string | undefined>(undefined);

  const [registerOpen, setRegisterOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [rejectTarget, setRejectTarget] = useState<Cashflow | null>(null);
  const [reverseTarget, setReverseTarget] = useState<Cashflow | null>(null);

  const [registerForm] = Form.useForm();
  const [configForm] = Form.useForm();
  const [rejectForm] = Form.useForm();
  const [reverseForm] = Form.useForm();
  const write = useAsyncAction();

  const selectedPools = useMemo(
    () => pools.filter((pool) => poolCodes.includes(pool.code)),
    [pools, poolCodes],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [savedPools, savedItems] = await Promise.all([
        readOptionSet(POOL_SET_CODE),
        readOptionSet(ITEM_SET_CODE),
      ]);
      const codes = (savedPools ?? []).map((item) => item.value);
      setPoolCodes(codes);
      if (savedItems && savedItems.length > 0) setExpenseItems(savedItems);
      setConfigLoaded(true);
      const allowedIds = pools.filter((pool) => codes.includes(pool.code)).map((pool) => pool.id);
      const scoped: Cashflow[] = [];
      if (allowedIds.length > 0) {
        // 手工登记的工作室收支来源恒为 OTHER（订单回款=ORDER_EVENT、押金/划转/返点各有专属来源），
        // 按「支出=运营消耗 / 收入=自营收入」拉取后，用 source=OTHER 精确切出手工口径。
        const [outRes, inRes] = await Promise.all([
          cashflowsApi.list({
            direction: "OUT",
            accounting_attribute: "OPERATING_EXPENSE",
            occurred_from: from || undefined,
            occurred_to: to || undefined,
            status,
            category,
            limit: FETCH_LIMIT,
          }),
          cashflowsApi.list({
            direction: "IN",
            accounting_attribute: "SELF_REVENUE",
            occurred_from: from || undefined,
            occurred_to: to || undefined,
            status,
            category,
            limit: FETCH_LIMIT,
          }),
        ]);
        for (const row of [...outRes.items, ...inRes.items]) {
          if (row.source === "OTHER" && allowedIds.includes(row.pool_id)) scoped.push(row);
        }
      }
      setFlows(scoped);
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setLoading(false);
    }
  }, [category, from, pools, status, to]);

  useEffect(() => {
    void load();
  }, [load]);

  const review = async (row: Cashflow, action: "approve" | "reject", reason?: string, formExtra?: Record<string, unknown>) => {
    await write.run(async () => {
      if (action === "approve") await cashflowsApi.approve(row.id);
      else await cashflowsApi.reject(row.id, reason ?? "", formExtra);
      appMessage.success(action === "approve" ? "支出已审核" : "支出已拒绝");
      setRejectTarget(null);
      rejectForm.resetFields();
      await load();
    });
  };

  const submitRegister = async (values: Record<string, unknown>) => {
    const direction = (values.direction as string) === "IN" ? "IN" : "OUT";
    await write.run(async () => {
      const flow = await cashflowsApi.create({
        pool_id: Number(values.pool_id),
        occurred_on: values.occurred_on as string,
        direction,
        nature: direction === "OUT" ? "BUSINESS_OUT" : "BUSINESS_IN",
        fund_nature: "BUSINESS",
        accounting_attribute: direction === "OUT" ? "OPERATING_EXPENSE" : "SELF_REVENUE",
        category: values.category as string,
        amount: values.amount as string,
        note: (values.note as string) || null,
        form_extra: (values.form_extra as Record<string, unknown> | undefined) ?? undefined,
      });
      // 关闭审核态：提交即入账，紧接自动补审核；失败不吞——提示去流水页手动审核。
      const flowId = (flow as { id?: number } | undefined)?.id;
      if (flowId) {
        try {
          await cashflowsApi.approve(flowId);
        } catch {
          appMessage.warning("已登记但自动审核未成功，请在「流水」页手动审核");
        }
      }
      appMessage.success(direction === "OUT" ? "支出已登记入账" : "收入已登记入账");
      setRegisterOpen(false);
      registerForm.resetFields();
      await load();
    });
  };

  const submitReverse = async (values: Record<string, unknown>) => {
    if (!reverseTarget) return;
    const targetId = reverseTarget.id;
    await write.run(async () => {
      await cashflowsApi.reverse(targetId, {
        reversed_on: values.reversed_on as string,
        reason: values.reason as string,
        form_extra: (values.form_extra as Record<string, unknown> | undefined) ?? undefined,
      });
      appMessage.success("支出已冲销");
      setReverseTarget(null);
      reverseForm.resetFields();
      await load();
    });
  };

  const submitConfig = async (values: Record<string, unknown>) => {
    const codes = (values.pool_codes as string[] | undefined) ?? [];
    await write.run(async () => {
      await writeOptionSet(
        POOL_SET_CODE,
        POOL_SET_LABEL,
        codes.map((code) => ({
          value: code,
          label: pools.find((pool) => pool.code === code)?.name ?? code,
        })),
      );
      const inputItems = (values.items as string[] | undefined) ?? [];
      if (inputItems.length > 0) {
        await writeOptionSet(
          ITEM_SET_CODE,
          ITEM_SET_LABEL,
          inputItems.map((value) => ({ value, label: value })),
        );
      }
      appMessage.success("工作室支出配置已保存");
      setConfigOpen(false);
      await load();
    });
  };

  const approvedIncome = flows
    .filter((row) => row.status === "APPROVED" && row.direction === "IN")
    .reduce((sum, row) => sum + Number(row.amount), 0)
    .toFixed(2);
  const approvedExpense = flows
    .filter((row) => row.status === "APPROVED" && row.direction === "OUT")
    .reduce((sum, row) => sum + Number(row.amount), 0)
    .toFixed(2);
  const netTotal = (Number(approvedIncome) - Number(approvedExpense)).toFixed(2);

  const [registerDirection, setRegisterDirection] = useState<string>("OUT");

  const columns: ColumnsType<Cashflow> = [
    { title: "日期", dataIndex: "occurred_on" },
    {
      title: "资金池",
      render: (_v, row) => pools.find((pool) => pool.id === row.pool_id)?.name ?? row.pool_id,
    },
    {
      title: "收支",
      dataIndex: "direction",
      width: 70,
      render: (v: string) => (v === "IN" ? "收入" : "支出"),
    },
    { title: "科目", dataIndex: "category" },
    {
      title: "金额",
      dataIndex: "amount",
      align: "right",
      render: (v: string) => <MoneyText value={v} />,
    },
    {
      title: "状态",
      dataIndex: "status",
      render: (v: string) => <StatusTag status={v} optionSet="FUND_FLOW_STATUS" />,
    },
    { title: "备注", dataIndex: "note", render: (v: string | null) => v || "—" },
    {
      title: "审核追溯",
      render: (_v, row) => (
        <span className="muted">
          {row.reviewed_by
            ? `${row.reviewed_by}${row.reviewed_at ? ` · ${row.reviewed_at.replace("T", " ").slice(0, 16)}` : ""}`
            : "—"}
          {row.reversal_of_id ? ` · 冲销#${row.reversal_of_id}` : ""}
        </span>
      ),
    },
    {
      title: "操作",
      width: 170,
      render: (_v, row) => (
        <Space size={2}>
          {row.status === "PENDING" && (
            <ConfirmButton
              permission="deposit.post"
              size="small"
              title="审核通过这笔工作室支出"
              description="审核后支出计入损益且不可撤销。如金额有误，请先冲销或拒绝。"
              okText="确认审核"
              onConfirm={() => review(row, "approve")}
            >
              审核
            </ConfirmButton>
          )}
          {row.status === "PENDING" && (
            <PermissionButton permission="deposit.post" size="small" onClick={() => setRejectTarget(row)}>
              拒绝
            </PermissionButton>
          )}
          {row.status === "APPROVED" && (
            <PermissionButton
              permission="deposit.post"
              size="small"
              onClick={() => {
                reverseForm.setFieldsValue({ reversed_on: today() });
                setReverseTarget(row);
              }}
            >
              冲销
            </PermissionButton>
          )}
        </Space>
      ),
    },
  ];

  return (
    <section className="ui-stack">
      <ErrorBanner error={error} onRetry={() => void load()} retrying={loading} />
      <Card
        className="glass"
        title="工作室收支"
        extra={
          <PermissionButton
            permission="option-set.manage"
            size="small"
            onClick={() => {
              configForm.setFieldsValue({
                pool_codes: poolCodes,
                items: expenseItems.map((item) => item.value),
              });
              setConfigOpen(true);
            }}
          >
            配置承载池
          </PermissionButton>
        }
      >
        <Typography.Paragraph type="secondary" className="ui-card-hint">
          口径：仅统计已勾选「承载资金池」上手工登记的收支流水（不含订单、押金、划转、返点）；登记即入账，无需审核。
        </Typography.Paragraph>
        <div className="ui-filter-bar">
          <Input aria-label="工作室支出开始日期" value={from} placeholder="开始日期" onChange={(event) => setFrom(event.target.value)} />
          <Input aria-label="工作室支出结束日期" value={to} placeholder="结束日期" onChange={(event) => setTo(event.target.value)} />
          <Select
            aria-label="工作室支出科目"
            allowClear
            value={category}
            placeholder="全部科目"
            options={expenseItems}
            onChange={setCategory}
          />
          <Select
            aria-label="工作室支出状态"
            allowClear
            value={status}
            placeholder="全部状态"
            options={[
              { value: "PENDING", label: "待审核" },
              { value: "APPROVED", label: "已审核" },
              { value: "REJECTED", label: "已拒绝" },
            ]}
            onChange={setStatus}
          />
          <PermissionButton permission="finance.read" onClick={() => void load()}>
            查询
          </PermissionButton>
          <PermissionButton
            permission="deposit.post"
            type="primary"
            onClick={() => {
              registerForm.setFieldsValue({ occurred_on: today(), direction: "OUT" });
              setRegisterDirection("OUT");
              setRegisterOpen(true);
            }}
          >
            记一笔
          </PermissionButton>
        </div>
        {configLoaded && selectedPools.length === 0 ? (
          <Typography.Text type="warning">
            尚未勾选任何承载资金池：请点右上角「配置承载池」，选定用于记录工作室收支的资金池。
          </Typography.Text>
        ) : null}
        <StatRow
          items={[
            { label: "已入账收入", amount: approvedIncome },
            { label: "已入账支出", amount: approvedExpense },
            { label: "净额", amount: netTotal },
            { label: "笔数", kind: "count", amount: flows.length },
          ]}
        />
        <DataTable<Cashflow>
          columns={columns}
          rows={flows}
          page={1}
          pageSize={10}
          total={flows.length}
          emptyText="暂无工作室支出"
          loading={loading}
          onPageChange={() => undefined}
       />
      </Card>

      <BusinessActionModal
        title="工作室收支登记"
        open={registerOpen}
        onCancel={() => setRegisterOpen(false)}
        footer={null}
      >
        <InlineError error={write.error} />
        <BusinessForm scope="STUDIOEXP" form={registerForm} onFinish={submitRegister}>
          <FieldConfigScope scope="STUDIOEXP" active={registerOpen}>
          <CfgItem name="pool_id" label="资金池" rules={[{ required: true, message: "请选择资金池" }]}>
            <Select
              options={selectedPools.map((pool) => ({ value: pool.id, label: `${pool.name}（${pool.code}）` }))}
              placeholder={selectedPools.length ? "选择资金池" : "请先在「配置承载池」勾选资金池"}
            />
          </CfgItem>
          <CfgItem name="occurred_on" label="日期" rules={[{ required: true, message: "请输入日期" }]}>
            <Input placeholder="YYYY-MM-DD" />
          </CfgItem>
          <CfgItem name="direction" label="收支" rules={[{ required: true, message: "请选择收支" }]}>
            <Select
              options={[
                { value: "OUT", label: "支出" },
                { value: "IN", label: "收入" },
              ]}
              onChange={(value: string) => {
                setRegisterDirection(value);
                registerForm.setFieldValue("category", undefined);
              }}
            />
          </CfgItem>
          <CfgItem name="category" label="科目" rules={[{ required: true, message: "请选择科目" }]}>
            <Select options={registerDirection === "OUT" ? expenseItems : INCOME_ITEMS} />
          </CfgItem>
          <CfgItem name="amount" label="金额" rules={requiredMoneyRules("金额")}>
            <MoneyInput />
          </CfgItem>
          <CfgItem name="note" label="备注">
            <Input.TextArea rows={2} />
          </CfgItem>
          <CustomFieldSection testIdSuffix="studio-expense" />
          <PermissionButton permission="deposit.post" type="primary" htmlType="submit" loading={write.pending}>
            登记入账
          </PermissionButton>
          </FieldConfigScope>
        </BusinessForm>
      </BusinessActionModal>

      <BusinessActionModal size="compact"
        title="配置工作室支出"
        open={configOpen}
        onCancel={() => setConfigOpen(false)}
        footer={null}
      >
        <InlineError error={write.error} />
        <BusinessForm scope="STUDIOEXP" form={configForm} onFinish={submitConfig}>
          <Form.Item
            name="pool_codes"
            label="承载资金池"
            extra="只有勾选的资金池可用于登记工作室支出，并纳入本页统计。"
            rules={[{ required: true, message: "请至少勾选一个资金池" }]}
          >
            <Select
              mode="multiple"
              placeholder="勾选记录工作室支出的资金池"
              options={pools.map((pool) => ({ value: pool.code, label: `${pool.name}（${pool.code}）` }))}
            />
          </Form.Item>
          <Form.Item name="items" label="费用科目" extra="可直接输入新增科目后回车">
            <Select mode="tags" placeholder="房租 / 日用 / 水电 …" />
          </Form.Item>
          <CompactActions>
            <PermissionButton permission="option-set.manage" type="primary" htmlType="submit" loading={write.pending}>
              保存配置
            </PermissionButton>
          </CompactActions>
        </BusinessForm>
      </BusinessActionModal>

      <BusinessActionModal size="compact"
        title="拒绝工作室支出"
        open={Boolean(rejectTarget)}
        onCancel={() => setRejectTarget(null)}
        footer={null}
      >
        <InlineError error={write.error} />
        <BusinessForm scope="STUDIOREJ" form={rejectForm} onFinish={(values) => review(rejectTarget!, "reject", values.reason as string, values.form_extra as Record<string, unknown> | undefined)}>
          <FieldConfigScope scope="STUDIOREJ" active={Boolean(rejectTarget)}>
          <CfgItem name="reason" label="拒绝原因" rules={[{ required: true, message: "请填写拒绝原因" }]}>
            <Input.TextArea rows={3} />
          </CfgItem>
          <CustomFieldSection testIdSuffix="studio-reject" />
          <CompactActions>
            <PermissionButton permission="deposit.post" type="primary" htmlType="submit" loading={write.pending}>
              确认拒绝
            </PermissionButton>
          </CompactActions>
          </FieldConfigScope>
        </BusinessForm>
      </BusinessActionModal>

      <BusinessActionModal size="compact"
        title="冲销工作室支出"
        open={Boolean(reverseTarget)}
        onCancel={() => setReverseTarget(null)}
        footer={null}
      >
        <InlineError error={write.error} />
        <BusinessForm scope="STUDIOREV" form={reverseForm} onFinish={submitReverse}>
          <FieldConfigScope scope="STUDIOREV" active={Boolean(reverseTarget)}>
          <CfgItem name="reversed_on" label="冲销日期" rules={[{ required: true, message: "请输入冲销日期" }]}>
            <Input placeholder="YYYY-MM-DD" />
          </CfgItem>
          <CfgItem name="reason" label="冲销原因" rules={[{ required: true, message: "请填写冲销原因" }]}>
            <Input.TextArea rows={3} />
          </CfgItem>
          <CustomFieldSection testIdSuffix="studio-reverse" />
          <CompactActions>
            <PermissionButton permission="deposit.post" type="primary" htmlType="submit" loading={write.pending}>
              确认冲销
            </PermissionButton>
          </CompactActions>
          </FieldConfigScope>
        </BusinessForm>
      </BusinessActionModal>
    </section>
  );
}
