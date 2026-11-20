import { appMessage } from "../shared/ui/appFeedback";
/** 工作室收支：在指定资金账户上快速登记日常开销与零星收入（房租 / 日用 / 水电 …）。
 *
 * 设计约束（刻意不新增后端表）：
 * - **入账复用「新增独立流水」**：支出 = OUT / OPERATING_EXPENSE，
 *   收入 = IN / SELF_REVENUE，科目落在 `category`。只存在一套入账口径。
 * - **不走审核态**：提交即入账（后端独立流水直接 APPROVED，登记即计入损益，无需审核）。
 * - **统一汇总全部资金账户**：工作室运营页不再按资金账户拆分筛选；登记时仍需选择入账资金账户。
 */
import { Card, DatePicker, Form, Input, Segmented, Space } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs, { type Dayjs } from "dayjs";
import { CfgItem, CustomFieldSections, FieldConfigScope } from "../business/ConfigurableField";
import { formExtraOrUndefined, mergeFormExtra } from "../shared/lib/formExtra";
import { useCallback, useEffect, useRef, useState } from "react";
import { cashflowsApi } from "../shared/api/cashflows.api";
import { studioExpensesApi } from "../shared/api/studioExpenses.api";
import { optionSetsApi } from "../shared/api/options.api";
import { employeesApi } from "../shared/api/org.api";
import type { OptionItem } from "../shared/api/types/common";
import type { Cashflow, Pool } from "../shared/api/types/finance";
import type { EmployeeOption } from "../shared/api/types/org";
import { normalizeError, type NormalizedError } from "../shared/api/client";
import { formatDateTimeMinute, today } from "../shared/lib/format";
import { requiredMoneyRules } from "../shared/lib/validators";
import { FUND_FLOW_SOURCE_LABEL, STUDIO_EXPENSE_ITEM_SET, STUDIO_INCOME_ITEMS } from "../shared/lib/labels";
import { ConfirmButton,
  DataTable,
  BusinessActionModal,
  BusinessRegistrationForm,
  ErrorBanner,
  InlineError,
  MoneyInput,
  MoneyText,
  PermissionButton,
  Select,
  StatRow,
} from "../shared/ui";
import { useAsyncAction } from "../shared/hooks/useAsyncAction";
import { ResponsibleEmployeeSelect } from "../business/ResponsibleEmployeeSelect";
import type { FundsPageController } from "./useFundsPageController";
import { useBusinessPeriod, type PeriodState } from "../shared/state/businessPeriod";
import { BusinessPeriodPicker } from "../shared/ui/BusinessPeriodPicker";
/** 弹窗视觉稿落地：作用域严格限定 .studio-ledger-modal（单一弹窗），不污染全站 .ant-modal。 */
import "./StudioExpensePanel.css";

/** 费用科目词典与收入科目已抽到 shared/lib/labels.ts（资金明细类别筛选共用同一事实源）。 */
const ITEM_SET_CODE = STUDIO_EXPENSE_ITEM_SET;

const INCOME_ITEMS: OptionItem[] = [...STUDIO_INCOME_ITEMS];

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

async function readOptionSet(code: string): Promise<OptionItem[]> {
  const set = await optionSetsApi.get(code);
  return set.options ?? [];
}

export function StudioExpensePanel({ pools, ctrl, periodState: suppliedPeriod }: { pools: Pool[]; ctrl?: FundsPageController; periodState?: PeriodState }) {
  const fallbackPeriod = useBusinessPeriod();
  const periodState = suppliedPeriod ?? fallbackPeriod;
  const [flows, setFlows] = useState<Cashflow[]>([]);
  const [summary, setSummary] = useState<{
    income: string;
    expense: string;
    net: string;
    count: number;
  } | null>(null);
  const [expenseItems, setExpenseItems] = useState<OptionItem[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<NormalizedError | null>(null);

  const [category, setCategory] = useState<string | undefined>(undefined);

  const [registerOpen, setRegisterOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Cashflow | null>(null);
  const [registerDirection, setRegisterDirection] = useState<string>("OUT");

  const [registerForm] = Form.useForm();
  const write = useAsyncAction();

  const from = periodState.period?.from ?? "";
  const to = periodState.period?.to ?? "";
  const filterKey = JSON.stringify([from, to, category]);
  const [paging, setPaging] = useState({ filterKey, page: 1, pageSize: 10 });
  const page = paging.filterKey === filterKey ? paging.page : 1;
  const pageSize = paging.pageSize;

  useEffect(() => {
    setPaging((current) => current.filterKey === filterKey ? current : { ...current, filterKey, page: 1 });
  }, [filterKey]);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve(employeesApi.list())
      .then((items) => {
        if (!cancelled) setEmployees((items ?? []).filter((item) => item.is_active));
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  // 筛选条件变化会重新触发 load；用请求序号丢弃过期响应，避免切类目/改日期后
  // 旧请求后到覆盖新结果（与 useLedgerList 同一范式）。
  const loadSeqRef = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    try {
      // 明细与已入账汇总一次取回：什么算工作室收支、收入/支出/净额怎么加，全在
      // service.studio_summary 里。前端不再拉两次、不再按 source 过滤、不再 reduce。
      const [, result] = await Promise.all([
        readOptionSet(ITEM_SET_CODE).then((savedItems) => {
          if (seq === loadSeqRef.current) setExpenseItems(savedItems);
        }),
        studioExpensesApi.summary({
          occurred_from: from || undefined,
          occurred_to: to || undefined,
          category,
          limit: pageSize,
          offset: (page - 1) * pageSize,
        }),
      ]);
      if (seq !== loadSeqRef.current) return;
      const lastPage = Math.max(1, Math.ceil(result.count / pageSize));
      if (page > lastPage) {
        setPaging({ filterKey, page: lastPage, pageSize });
        return;
      }
      setFlows(result.items);
      setSummary(result);
      setError(null);
    } catch (err) {
      if (seq === loadSeqRef.current) setError(normalizeError(err));
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, [category, from, to, filterKey, page, pageSize]);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (periodState.ready && (ctrl?.active ?? true)) void load();
    return () => { loadSeqRef.current += 1; };
  }, [load, periodState.ready, ctrl?.active]);

  const submitRegister = async (values: Record<string, unknown>) => {
    const direction = (values.direction as string) === "IN" ? "IN" : "OUT";
    const editing = editTarget;
    await write.run(async () => {
      const payload = {
        pool_id: Number(values.pool_id),
        occurred_on: dateText(values.occurred_on),
        direction,
        ledger_type: "STUDIO",
        accounting_attribute: direction === "OUT" ? "OPERATING_EXPENSE" : "SELF_REVENUE",
        category: values.category as string,
        amount: values.amount as string,
        note: (values.note as string) || null,
        operator_user_ids: values.operator_user_ids as number[] | undefined,
        form_extra: editing
          ? mergeFormExtra(values.form_extra, editing.form_extra)
          : formExtraOrUndefined(values.form_extra),
      };
      if (editing) {
        await cashflowsApi.update(editing.id, payload);
        appMessage.success("工作室收支已更新");
      } else {
        await cashflowsApi.create(payload);
        appMessage.success(direction === "OUT" ? "支出已登记" : "收入已登记");
      }
      setRegisterOpen(false);
      setEditTarget(null);
      registerForm.resetFields();
      await Promise.all([loadRef.current(), ctrl?.load()]);
    });
  };

  const deleteStudioCashflow = async (cashflowId: number) => {
    await write.run(async () => {
      await cashflowsApi.remove(cashflowId);
      appMessage.success("工作室收支已删除");
      await Promise.all([loadRef.current(), ctrl?.load()]);
    });
  };

  const openRegister = () => {
    write.clearError();
    setEditTarget(null);
    registerForm.resetFields();
    registerForm.setFieldsValue({ occurred_on: dayjs(today()), direction: "OUT" });
    setRegisterDirection("OUT");
    setRegisterOpen(true);
  };

  const openEdit = (row: Cashflow) => {
    write.clearError();
    setEditTarget(row);
    setRegisterDirection(row.direction === "IN" ? "IN" : "OUT");
    registerForm.resetFields();
    registerForm.setFieldsValue({
      pool_id: row.pool_id,
      occurred_on: dayjs(row.occurred_on),
      direction: row.direction,
      category: row.category,
      amount: row.amount,
      note: row.note ?? undefined,
      operator_user_ids: row.operator_user_ids ?? undefined,
      form_extra: row.form_extra ?? undefined,
    });
    setRegisterOpen(true);
  };

  const closeRegister = () => {
    write.clearError();
    setRegisterOpen(false);
    setEditTarget(null);
    registerForm.resetFields();
  };

  // 三个金额与笔数都取服务端（Decimal 聚合 / 全量 COUNT），前端只负责显示。
  const income = summary?.income ?? "0.00";
  const expense = summary?.expense ?? "0.00";
  const netTotal = summary?.net ?? "0.00";
  const flowCount = summary?.count ?? 0;
  const categoryOptions = Array.from(
    new Map([...expenseItems, ...INCOME_ITEMS].map((item) => [item.value, item])).values(),
  );

  const columns: ColumnsType<Cashflow> = [
    { title: "流水号", dataIndex: "flow_no" },
    { title: "日期", dataIndex: "occurred_on" },
    {
      title: "资金账户",
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
    { title: "来源", dataIndex: "source", render: (v: string | null | undefined) => v ? (FUND_FLOW_SOURCE_LABEL[v] ?? v) : "—" },
    { title: "建立时间", dataIndex: "occurred_at", render: (v: string | null | undefined) => formatDateTimeMinute(v) },
    { title: "操作人", dataIndex: "operator_user_ids", render: (ids: number[] | null | undefined, row) => (ids ?? []).map((id) => employees.find((employee) => employee.id === id)?.display_name ?? `用户 ${id}`).join("、") || row.operator || "-" },
    { title: "备注", dataIndex: "note", render: (v: string | null) => v || "—" },
    {
      title: "操作",
      width: 150,
      render: (_v, row) => (
        // 冲销流水及已冲销的原流水均不可编辑或删除。
        row.source_type !== "MANUAL" || row.is_reversed ? null : (
          <Space size={2}>
            <PermissionButton permission="deposit.post" size="small" onClick={() => openEdit(row)}>
              编辑
            </PermissionButton>
            <ConfirmButton
              permission="deposit.post"
              size="small"
              danger
              title="删除工作室收支"
              description="删除后会立即移除这笔工作室收支及其经营统计，且不可恢复。"
              okText="确认删除"
              onConfirm={() => deleteStudioCashflow(row.id)}
            >
              删除
            </ConfirmButton>
          </Space>
        )
      ),
    },
  ];

  return (
    <Card
      className="glass studio-expense-shell"
      title="工作室运营"
      extra={
        <PermissionButton
          permission="deposit.post"
          type="primary"
          disabled={Boolean(error)}
          onClick={openRegister}
        >
          记一笔
        </PermissionButton>
      }
    >
      <section className="ui-stack">
      <ErrorBanner error={error} onRetry={() => void load()} retrying={loading} />
      {!registerOpen && <InlineError error={write.error} />}
      <StatRow
        items={[
          // 失败态一律显示「—」（amount: null），不把未知状态当成可信 0
          { label: "收入", amount: loading || error ? null : income },
          { label: "支出", amount: loading || error ? null : expense },
          { label: "净额", amount: loading || error ? null : netTotal },
          { label: "笔数", kind: "count", amount: loading || error ? null : flowCount },
        ]}
      />
      <Card className="glass studio-expense-card">
        <div className="ui-filter-bar studio-expense-filters studio-expense-filters--single-row">
          <BusinessPeriodPicker label="工作室支出日期区间" state={periodState} showAll />
          <Select
            aria-label="工作室收支科目"
            allowClear
            value={category}
            placeholder="全部科目"
            options={categoryOptions}
            onChange={setCategory}
          />
        </div>
        <DataTable<Cashflow>
          columns={columns}
          rows={error ? [] : flows}
          page={page}
          pageSize={pageSize}
          total={flowCount}
          controlledPaging
          emptyText={error ? "工作室收支数据不可用，请点击重新加载" : "暂无工作室收支"}
          loading={loading}
          pagination={error ? false : undefined}
          onPageChange={(nextPage, nextPageSize) => setPaging({ filterKey, page: nextPageSize === pageSize ? nextPage : 1, pageSize: nextPageSize })}
       />
      </Card>

      {/* 6 个字段的操作弹窗：compact 560 宽比 full 1200 更贴合体量；
          studio-ledger-modal 是视觉稿的唯一作用域锚点（样式见 StudioExpensePanel.css）。 */}
      <BusinessActionModal
        size="compact"
        wrapClassName="studio-ledger-modal"
        title={editTarget ? "编辑工作室收支" : REGISTER_TITLE}
        open={registerOpen}
        onCancel={closeRegister}
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
          <CfgItem name="pool_id" label="资金账户" rules={[{ required: true, message: "请选择资金账户" }]}>
            <Select
              options={pools.map((pool) => ({ value: pool.id, label: pool.name }))}
              placeholder="选择资金账户"
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
          <ResponsibleEmployeeSelect name="operator_user_ids" label="操作人" employees={employees} />
          <CustomFieldSections testIdSuffix="studio-expense" />
          <PermissionButton permission="deposit.post" type="primary" htmlType="submit" loading={write.pending}>
            {editTarget ? "保存修改" : "登记入账"}
          </PermissionButton>
          </FieldConfigScope>
        </BusinessRegistrationForm>
      </BusinessActionModal>

      </section>
    </Card>
  );
}
