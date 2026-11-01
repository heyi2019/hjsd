import { appMessage } from "../shared/ui/appFeedback";
/** 工作室收支：在指定资金池上快速登记日常开销与零星收入（房租 / 日用 / 水电 …）。
 *
 * 设计约束（刻意不新增后端表）：
 * - **入账复用「新增独立流水」**：支出 = OUT / BUSINESS_OUT / OPERATING_EXPENSE，
 *   收入 = IN / BUSINESS_IN / SELF_REVENUE，科目落在 `category`。只存在一套入账口径。
 * - **不走审核态**：提交即入账（后端独立流水直接 APPROVED，登记即计入损益，无需审核）。
 * - **承载资金池可直接勾选**：页面内选择池，不写入业务配置；费用科目仍落在
 *   `STUDIO_EXPENSE_ITEM` 词典，服务端存储 ⇒ 全员同步。
 */
import { Card, DatePicker, Form, Input, Space, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs, { type Dayjs } from "dayjs";
import { CfgItem, CustomFieldSection, FieldConfigScope } from "../orders/ConfigurableField";
import { useCallback, useEffect, useMemo, useState } from "react";
import { cashflowsApi,
  optionSetsApi,
  type Cashflow,
  type OptionItem,
  type Pool, } from "../shared/api/catalog";
import { normalizeError, type NormalizedError } from "../shared/api/client";
import { formatDateTimeMinute, today } from "../shared/lib/format";
import { clearOptionSetsCache } from "../shared/lib/optionSets";
import { requiredMoneyRules } from "../shared/lib/validators";
import { DataTable,
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
  CompactActions, } from "../shared/ui";
import { useAsyncAction } from "../shared/hooks/useAsyncAction";
import { DepositSection } from "./FundsPage.tabs";
import type { FundsPageController } from "./useFundsPageController";

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

function dateText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof (value as { format?: unknown }).format === "function") {
    return (value as Dayjs).format("YYYY-MM-DD");
  }
  return "";
}

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

export function StudioExpensePanel({ pools, ctrl }: { pools: Pool[]; ctrl?: FundsPageController }) {
  const [flows, setFlows] = useState<Cashflow[]>([]);
  const [poolCodes, setPoolCodes] = useState<string[]>([]);
  const [expenseItems, setExpenseItems] = useState<OptionItem[]>(DEFAULT_EXPENSE_ITEMS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<NormalizedError | null>(null);

  const [dateRange, setDateRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [category, setCategory] = useState<string | undefined>(undefined);

  const [registerOpen, setRegisterOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [reverseTarget, setReverseTarget] = useState<Cashflow | null>(null);

  const [registerForm] = Form.useForm();
  const [configForm] = Form.useForm();
  const [reverseForm] = Form.useForm();
  const write = useAsyncAction();

  const from = dateRange?.[0]?.format("YYYY-MM-DD") ?? "";
  const to = dateRange?.[1]?.format("YYYY-MM-DD") ?? "";

  const selectedPools = useMemo(
    () => pools.filter((pool) => poolCodes.includes(pool.code)),
    [pools, poolCodes],
  );

  useEffect(() => {
    setPoolCodes((current) => {
      const available = new Set(pools.map((pool) => pool.code));
      const retained = current.filter((code) => available.has(code));
      return current.length === 0 && pools.length > 0 ? pools.map((pool) => pool.code) : retained;
    });
  }, [pools]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const savedItems = await readOptionSet(ITEM_SET_CODE);
      if (savedItems && savedItems.length > 0) setExpenseItems(savedItems);
      const allowedIds = pools.filter((pool) => poolCodes.includes(pool.code)).map((pool) => pool.id);
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
  }, [category, dateRange, pools, poolCodes, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitRegister = async (values: Record<string, unknown>) => {
    const direction = (values.direction as string) === "IN" ? "IN" : "OUT";
    await write.run(async () => {
      await cashflowsApi.create({
        pool_id: Number(values.pool_id),
        occurred_on: dateText(values.occurred_on),
        direction,
        nature: direction === "OUT" ? "BUSINESS_OUT" : "BUSINESS_IN",
        fund_nature: "BUSINESS",
        accounting_attribute: direction === "OUT" ? "OPERATING_EXPENSE" : "SELF_REVENUE",
        category: values.category as string,
        amount: values.amount as string,
        note: (values.note as string) || null,
        form_extra: (values.form_extra as Record<string, unknown> | undefined) ?? undefined,
      });
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
        reversed_on: dateText(values.reversed_on),
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
    await write.run(async () => {
      const inputItems = (values.items as string[] | undefined) ?? [];
      if (inputItems.length > 0) {
        await writeOptionSet(
          ITEM_SET_CODE,
          ITEM_SET_LABEL,
          inputItems.map((value) => ({ value, label: value })),
        );
      }
      appMessage.success("工作室费用科目已保存");
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
    { title: "流水号", dataIndex: "flow_no" },
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
    { title: "来源", dataIndex: "source", render: (v: string | null | undefined) => v === "OTHER" ? "手工登记" : v || "—" },
    { title: "建立时间", dataIndex: "occurred_at", render: (v: string | null | undefined) => formatDateTimeMinute(v) },
    { title: "备注", dataIndex: "note", render: (v: string | null) => v || "—" },
    {
      title: "操作",
      width: 170,
      render: (_v, row) => (
        <Space size={2}>
          {row.status === "APPROVED" && (
            <PermissionButton
              permission="deposit.post"
              size="small"
              onClick={() => {
                reverseForm.setFieldsValue({ reversed_on: dayjs(today()) });
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
        extra={
          <PermissionButton
            permission="option-set.manage"
            size="small"
            onClick={() => {
              configForm.setFieldsValue({
                items: expenseItems.map((item) => item.value),
              });
              setConfigOpen(true);
            }}
          >
            配置费用科目
          </PermissionButton>
        }
      >
        <div className="ui-filter-bar studio-expense-pools studio-expense-pools--spaced studio-expense-pools--single-row">
          <PermissionButton
            permission="deposit.post"
            type="primary"
            onClick={() => {
              registerForm.setFieldsValue({ occurred_on: dayjs(today()), direction: "OUT" });
              setRegisterDirection("OUT");
              setRegisterOpen(true);
            }}
          >
            记一笔
          </PermissionButton>
          <Typography.Text strong>承载资金池</Typography.Text>
          <Select
            mode="multiple"
            aria-label="工作室收支资金池"
            allowClear
            maxTagCount="responsive"
            className="ui-control-width-studio-pool"
            value={poolCodes}
            placeholder="选择承载资金池"
            options={pools.map((pool) => ({ value: pool.code, label: `${pool.name}（${pool.code}）` }))}
            onChange={(values) => setPoolCodes(values as string[])}
          />
        </div>
        <div className="ui-filter-bar studio-expense-filters studio-expense-filters--single-row">
          <DatePicker.RangePicker
            aria-label="工作室支出日期区间"
            placeholder={["开始日期", "结束日期"]}
            format="YYYY-MM-DD"
            size="small"
            classNames={{ popup: { root: "compact-date-range-picker" } }}
            value={dateRange}
            onChange={(value) => setDateRange(value?.[0] && value[1] ? [value[0], value[1]] : null)}
          />
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
            options={[{ value: "APPROVED", label: "已入账" }]}
            onChange={setStatus}
          />
        </div>
        {selectedPools.length === 0 ? (
          <Typography.Text type="warning">
            尚未选择任何承载资金池：请在上方选择用于记录工作室收支的资金池。
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
          emptyText="暂无工作室收支"
          loading={loading}
          onPageChange={() => undefined}
       />
      </Card>

      {ctrl ? <DepositSection ctrl={ctrl} /> : null}

      <BusinessActionModal
        title="工作室收支登记"
        open={registerOpen}
        onCancel={() => setRegisterOpen(false)}
        footer={null}
      >
        <InlineError error={write.error} />
        <BusinessForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }}
          scope="STUDIOEXP"
          form={registerForm}
          onFinish={submitRegister}
        >
          <FieldConfigScope scope="STUDIOEXP" active={registerOpen}>
          <CfgItem name="pool_id" label="资金池" rules={[{ required: true, message: "请选择资金池" }]}>
            <Select
              options={selectedPools.map((pool) => ({ value: pool.id, label: `${pool.name}（${pool.code}）` }))}
              placeholder={selectedPools.length ? "选择资金池" : "请先在上方勾选资金池"}
            />
          </CfgItem>
          <CfgItem name="occurred_on" label="日期" rules={[{ required: true, message: "请输入日期" }]}>
            <DatePicker format="YYYY-MM-DD" />
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
        title="配置工作室费用科目"
        open={configOpen}
        onCancel={() => setConfigOpen(false)}
        footer={null}
      >
        <InlineError error={write.error} />
        <BusinessForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} scope="STUDIOEXP" form={configForm} onFinish={submitConfig}>
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
        title="冲销工作室支出"
        open={Boolean(reverseTarget)}
        onCancel={() => setReverseTarget(null)}
        footer={null}
      >
        <InlineError error={write.error} />
        <BusinessForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} scope="STUDIOREV" form={reverseForm} onFinish={submitReverse}>
          <FieldConfigScope scope="STUDIOREV" active={Boolean(reverseTarget)}>
          <CfgItem name="reversed_on" label="冲销日期" rules={[{ required: true, message: "请输入冲销日期" }]}>
            <DatePicker format="YYYY-MM-DD" />
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
