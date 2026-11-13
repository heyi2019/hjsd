import { appMessage } from "../shared/ui/appFeedback";
/** 工作室收支：在指定资金池上快速登记日常开销与零星收入（房租 / 日用 / 水电 …）。
 *
 * 设计约束（刻意不新增后端表）：
 * - **入账复用「新增独立流水」**：支出 = OUT / BUSINESS_OUT / OPERATING_EXPENSE，
 *   收入 = IN / BUSINESS_IN / SELF_REVENUE，科目落在 `category`。只存在一套入账口径。
 * - **不走审核态**：提交即入账（后端独立流水直接 APPROVED，登记即计入损益，无需审核）。
 * - **资金池可直接筛选**：页面内选择池，不写入业务配置；费用科目仍落在
 *   `STUDIO_EXPENSE_ITEM` 词典，服务端存储 ⇒ 全员同步。
 */
import { Card, DatePicker, Form, Input, Segmented, Space, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs, { type Dayjs } from "dayjs";
import { CfgItem, CustomFieldSection, FieldConfigScope } from "../orders/ConfigurableField";
import { useCallback, useEffect, useMemo, useState } from "react";
import { cashflowsApi } from "../shared/api/cashflows.api";
import { optionSetsApi } from "../shared/api/options.api";
import type { OptionItem } from "../shared/api/types/common";
import type { Cashflow, Pool } from "../shared/api/types/finance";
import { normalizeError, type NormalizedError } from "../shared/api/client";
import { formatDateTimeMinute, today } from "../shared/lib/format";
import { requiredMoneyRules } from "../shared/lib/validators";
import { DataTable,
  BusinessActionModal,
  BusinessRegistrationForm,
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
/** 弹窗视觉稿落地：作用域严格限定 .studio-ledger-modal（单一弹窗），不污染全站 .ant-modal。 */
import "./StudioExpensePanel.css";

/** 费用科目词典。 */
const ITEM_SET_CODE = "STUDIO_EXPENSE_ITEM";

const DEFAULT_EXPENSE_ITEMS: OptionItem[] = [
  { value: "房租", label: "房租" },
  { value: "日用", label: "日用" },
  { value: "水电", label: "水电" },
  { value: "物业", label: "物业" },
  { value: "其他", label: "其他" },
];

const INCOME_ITEMS: OptionItem[] = [
  { value: "货款", label: "货款" },
  // 「退款」已随订单售后退款专用链路下线（退款统一并入普通支出）：收入科目不再保留退款。
  { value: "其他", label: "其他" },
];

/** 单次拉取上限：按日期区间查询，200 条覆盖月度收支足够。 */
const FETCH_LIMIT = 200;

/** 登记弹窗标题节点：图标砖 + 主副标题。
 * BusinessActionModal 只对字符串标题包拖拽 handle，传节点则由本节点自行承担（见 .studio-ledger-head 的 grab 光标）。 */
const REGISTER_TITLE = (
  <div className="studio-ledger-head">
    <span className="studio-ledger-head__icon" aria-hidden="true">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 7h18M3 12h18M3 17h12" />
        <path d="M16 15l2 2 4-4" />
      </svg>
    </span>
    <span className="studio-ledger-head__text">
      <span className="studio-ledger-head__title">工作室收支登记</span>
      <span className="studio-ledger-head__sub">登记一笔收入或支出流水</span>
    </span>
  </div>
);

/** 收支两项固定：支出 / 收入属于资金流水的语义约束，不交给表单字段配置改写。 */
const DIRECTION_OPTIONS = [
  { value: "OUT", label: "支出" },
  { value: "IN", label: "收入" },
];

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

export function StudioExpensePanel({ pools, ctrl }: { pools: Pool[]; ctrl?: FundsPageController }) {
  const [flows, setFlows] = useState<Cashflow[]>([]);
  const [summary, setSummary] = useState<{
    approved_income: string;
    approved_expense: string;
    approved_net: string;
    count: number;
  } | null>(null);
  const [poolCodes, setPoolCodes] = useState<string[]>([]);
  const [expenseItems, setExpenseItems] = useState<OptionItem[]>(DEFAULT_EXPENSE_ITEMS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<NormalizedError | null>(null);

  const [dateRange, setDateRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [category, setCategory] = useState<string | undefined>(undefined);

  const [registerOpen, setRegisterOpen] = useState(false);
  const [reverseTarget, setReverseTarget] = useState<Cashflow | null>(null);

  const [registerForm] = Form.useForm();
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
      if (allowedIds.length === 0) {
        setFlows([]);
        setSummary(null);
        setError(null);
        return;
      }
      // 明细与已入账汇总一次取回：什么算工作室收支、收入/支出/净额怎么加，全在
      // service.studio_summary 里。前端不再拉两次、不再按 source 过滤、不再 reduce。
      const result = await cashflowsApi.studioSummary({
        pool_ids: allowedIds.join(","),
        occurred_from: from || undefined,
        occurred_to: to || undefined,
        category,
        limit: FETCH_LIMIT,
      });
      setFlows(result.items);
      setSummary(result);
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setLoading(false);
    }
  }, [category, from, to, pools, poolCodes]);

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

  // 三个数都取服务端（Decimal 聚合，含净额），前端只负责显示。
  const approvedIncome = summary?.approved_income ?? "0.00";
  const approvedExpense = summary?.approved_expense ?? "0.00";
  const netTotal = summary?.approved_net ?? "0.00";

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
      <div className="studio-expense-page-actions">
        <PermissionButton
          permission="deposit.post"
          type="primary"
          disabled={Boolean(error)}
          onClick={() => {
            registerForm.setFieldsValue({ occurred_on: dayjs(today()), direction: "OUT" });
            setRegisterDirection("OUT");
            setRegisterOpen(true);
          }}
        >
          记一笔
        </PermissionButton>
      </div>
      <StatRow
        items={[
          // 失败态一律显示「—」（amount: null），不把未知状态当成可信 0
          { label: "已入账收入", amount: error ? null : approvedIncome },
          { label: "已入账支出", amount: error ? null : approvedExpense },
          { label: "净额", amount: error ? null : netTotal },
          { label: "笔数", kind: "count", amount: error ? null : flows.length },
        ]}
      />
      <Card className="glass studio-expense-card">
        <div className="ui-filter-bar studio-expense-filters studio-expense-filters--single-row">
          <DatePicker.RangePicker
            aria-label="工作室支出日期区间"
            placeholder={["开始日期", "结束日期"]}
            format="YYYY-MM-DD"
            size="small"
            placement="bottomLeft"
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
          <Typography.Text strong>资金池筛选</Typography.Text>
          <Select
            mode="multiple"
            aria-label="资金池筛选"
            allowClear
            maxTagCount="responsive"
            className="ui-control-width-studio-pool"
            value={poolCodes}
            placeholder="选择资金池"
            options={pools.map((pool) => ({ value: pool.code, label: pool.name }))}
            onChange={(values) => setPoolCodes(values as string[])}
          />
        </div>
        {selectedPools.length === 0 ? (
          <Typography.Text type="warning">
            尚未选择资金池：请在上方选择用于筛选工作室收支的资金池。
          </Typography.Text>
        ) : null}
        <DataTable<Cashflow>
          columns={columns}
          rows={flows}
          page={1}
          pageSize={10}
          total={flows.length}
          emptyText="暂无工作室收支"
          loading={loading}
          pagination={error ? false : undefined}
          onPageChange={() => undefined}
       />
      </Card>

      {ctrl ? <DepositSection ctrl={ctrl} /> : null}

      {/* 6 个字段的操作弹窗：compact 560 宽比 full 1200 更贴合体量；
          studio-ledger-modal 是视觉稿的唯一作用域锚点（样式见 StudioExpensePanel.css）。 */}
      <BusinessActionModal
        size="compact"
        wrapClassName="studio-ledger-modal"
        title={REGISTER_TITLE}
        open={registerOpen}
        onCancel={() => setRegisterOpen(false)}
        footer={null}
      >
        <InlineError error={write.error} />
        <BusinessRegistrationForm
          className="studio-ledger-form"
          layout="horizontal"
          labelAlign="right"
          labelCol={{ flex: "76px" }}
          wrapperCol={{ flex: "auto" }}
          scope="STUDIOEXP"
          form={registerForm}
          onFinish={submitRegister}
        >
          <FieldConfigScope scope="STUDIOEXP" active={registerOpen}>
          <CfgItem name="pool_id" label="资金池" rules={[{ required: true, message: "请选择资金池" }]}>
            <Select
              options={selectedPools.map((pool) => ({ value: pool.id, label: pool.name }))}
              placeholder={selectedPools.length ? "选择资金池" : "请先在上方勾选资金池"}
            />
          </CfgItem>
          <CfgItem name="occurred_on" label="日期" rules={[{ required: true, message: "请输入日期" }]}>
            <DatePicker format="YYYY-MM-DD" />
          </CfgItem>
          <CfgItem name="direction" label="收支" rules={[{ required: true, message: "请选择收支" }]}>
            {/* 两项互斥且高频：分段控件一步可选，比「点开下拉再选」少一次点击 */}
            <Segmented
              block
              options={DIRECTION_OPTIONS}
              onChange={(value) => {
                setRegisterDirection(String(value));
                registerForm.setFieldValue("category", undefined);
              }}
            />
          </CfgItem>
          <CfgItem name="category" label="科目" rules={[{ required: true, message: "请选择科目" }]}>
            <Select
              options={registerDirection === "OUT" ? expenseItems : INCOME_ITEMS}
              placeholder="请选择科目"
            />
          </CfgItem>
          <CfgItem name="amount" label="金额" rules={requiredMoneyRules("金额")}>
            <MoneyInput placeholder="0.00" />
          </CfgItem>
          <CfgItem name="note" label="备注">
            <Input.TextArea rows={2} />
          </CfgItem>
          <CustomFieldSection testIdSuffix="studio-expense" />
          <PermissionButton permission="deposit.post" type="primary" htmlType="submit" loading={write.pending}>
            登记入账
          </PermissionButton>
          </FieldConfigScope>
        </BusinessRegistrationForm>
      </BusinessActionModal>

      <BusinessActionModal size="compact"
        title="冲销工作室支出"
        open={Boolean(reverseTarget)}
        onCancel={() => setReverseTarget(null)}
        footer={null}
      >
        <InlineError error={write.error} />
        <BusinessRegistrationForm
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
        </BusinessRegistrationForm>
      </BusinessActionModal>
    </section>
  );
}
