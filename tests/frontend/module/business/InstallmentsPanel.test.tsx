import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appMessage as message } from "@/shared/ui/appFeedback";
import { renderLight } from "@fixtures/render";
import { resolveMockOnce } from "@fixtures/mock-api";
import { InstallmentsPanel } from "@/installments/InstallmentsPanel";

import { installmentsApi } from "@/shared/api/installments.api";
import { listColumnsApi, ordersApi } from "@/shared/api/orders.api";
import { seedOrderFormFields } from "@fixtures/formFieldsSeed";
vi.mock("@/shared/api/cashflows.api");
vi.mock("@/shared/api/customers.api");
vi.mock("@/shared/api/installments.api");
vi.mock("@/shared/api/misc.api");
vi.mock("@/shared/api/options.api");
vi.mock("@/shared/api/orders.api");
vi.mock("@/shared/api/org.api");
vi.mock("@/shared/api/policy.api");
vi.mock("@/shared/api/pools.api");
vi.mock("@/shared/api/rebates.api");
vi.mock("@/shared/api/reports.api");
vi.mock("@/shared/api/stocks.api");

const installments = [
  {
    id: 1,
    inst_no: "HS0001-INS01",
    contract_type: "STOCK_SALE",
    order_id: 10,
    down_payment: "100.00",
    principal: "300.00",
    service_fee: "0.00",
    per_period_service_fee: "0.00",
    per_period: "50.00",
    periods: 4,
    paid_amount: "150.00",
    total_receivable: "300.00",
    remaining_receivable: "150.00",
    status: "ACTIVE",
  },
  {
    id: 2,
    inst_no: "HS0002-INS01",
    contract_type: "STOCK_SALE",
    order_id: 10,
    down_payment: "0.00",
    principal: "200.00",
    service_fee: "0.00",
    per_period_service_fee: "0.00",
    per_period: "100.00",
    periods: 2,
    paid_amount: "200.00",
    total_receivable: "200.00",
    remaining_receivable: "0.00",
    status: "DELIVERED",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  seedOrderFormFields();
  vi.mocked(installmentsApi.list).mockResolvedValue(installments);
  vi.mocked(installmentsApi.schedules).mockResolvedValue([
    { id: 1, installment_id: 1, period_no: 0, due_on: "2026-10-01", due_amount: "100.00", received_amount: "100.00", status: "PAID" },
  ]);
  vi.mocked(installmentsApi.dispositions).mockResolvedValue([]);
  // 合计由服务端下发（Decimal 聚合）；「300+200」这类算术的契约在
  // backend tests/v1/test_installment_totals.py，前端只验展示。
  vi.mocked(installmentsApi.totals).mockResolvedValue({
    total_receivable: "500.00",
    total_paid: "350.00",
    total_remaining: "150.00",
    total_count: 2,
    overdue_count: 0,
  });
  vi.mocked(ordersApi.list).mockResolvedValue([{ id: 10, order_no: "HS-2026-0010", order_type: "HS", capital_type: "SELF", trade_date: "2026-10-01", status: "ACTIVE" }]);
});

describe("InstallmentsPanel：分期合约", () => {
  it("只展示分期出售，不展示代分期/提号分期/代挂分期", async () => {
    renderLight(<InstallmentsPanel />, { user: "admin" });
    expect(await screen.findByText("HS0001-INS01")).toBeInTheDocument();
    // 代分期（DFQ）下线后本面板专营库存分期出售（contractType=STOCK_SALE），
    // 不再有分期类型切换页签，故断言「无任何 tab」而非「选中分期出售 tab」。
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    for (const name of ["代分期", "提号分期", "代挂分期"]) {
      expect(screen.queryByText(name)).toBeNull();
    }
  });

  it("渲染合约号并把 order_id 映射成订单号", async () => {
    renderLight(<InstallmentsPanel />, { user: "admin" });
    expect(await screen.findByText("HS0001-INS01")).toBeInTheDocument();
    expect(screen.getAllByText("HS-2026-0010").length).toBeGreaterThanOrEqual(1);
  });

  it("提供分期合约日期区间筛选", async () => {
    renderLight(<InstallmentsPanel />, { user: "admin" });

    await screen.findByText("HS0001-INS01");
    expect(screen.getByPlaceholderText("开始日期")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("结束日期")).toBeInTheDocument();
  });

  it("坏账列使用列表配置键参与排序", async () => {
    vi.mocked(listColumnsApi.all).mockResolvedValueOnce([{
      code: "INSTALLMENT",
      label: "分期与回款",
      columns: [
        { key: "bad_debt", label: "坏账", locked: false, is_visible: true, sort_order: 0 },
        { key: "inst_no", label: "合约号", locked: false, is_visible: true, sort_order: 10 },
      ],
    }]);

    renderLight(<InstallmentsPanel />, { user: "admin" });
    await screen.findByText("HS0001-INS01");
    const headers = Array.from(document.querySelectorAll(".ant-table-thead tr:first-child th"))
      .map((header) => header.textContent?.trim())
      .filter(Boolean);
    expect(headers[0]).toBe("坏账");
  });

  it("总应收 = 首付 + 每期 × 期数（前端只做展示，不参与登记）", async () => {
    renderLight(<InstallmentsPanel />, { user: "admin" });
    await screen.findByText("HS0001-INS01");
    // 100 + 50*4 = 300.00
    expect(screen.getAllByText("300.00").length).toBeGreaterThanOrEqual(1);
    // 剩余 = 300 - 150 = 150.00
    expect(screen.getAllByText("150.00").length).toBeGreaterThanOrEqual(1);
  });

  it("列表与合计同带 contract_type，口径不混入其它类型合约", async () => {
    renderLight(<InstallmentsPanel />, { user: "admin" });
    await screen.findByText("HS0001-INS01");
    // 面板专营库存分期出售（STOCK_SALE）：列表与合计必须把同一 contract_type 下发给服务端，
    // 否则合计会把提号/其它类型合约的钱算进来（#4）。
    expect(vi.mocked(installmentsApi.list)).toHaveBeenCalledWith(
      expect.objectContaining({ contract_type: "STOCK_SALE" }),
    );
    expect(vi.mocked(installmentsApi.totals)).toHaveBeenCalledWith(
      expect.objectContaining({ contract_type: "STOCK_SALE" }),
    );
  });

  it("统计卡：应收与已收取服务端合计（金额口径）", async () => {
    renderLight(<InstallmentsPanel />, { user: "admin" });
    await screen.findAllByText("总应收");
    // 「总应收」同时是统计卡 label 与表头 → 只在统计卡容器里找
    const receivable = screen
      .getAllByText("总应收")
      .map((el) => el.closest(".ui-stat"))
      .find(Boolean);
    expect(receivable?.textContent).toContain("500.00");
    const paid = screen
      .getAllByText("已收合计")
      .map((el) => el.closest(".ui-stat"))
      .find(Boolean);
    expect(paid?.textContent).toContain("350.00");
  });

  it("合计取服务端，不与当页明细相加（明细只回当前区间）", async () => {
    // 故意让服务端合计与两条明细之和（500 / 350）不同：卡片不得自己 reduce。
    vi.mocked(installmentsApi.totals).mockResolvedValue({
      total_receivable: "12345.67",
      total_paid: "8901.23",
      total_remaining: "3444.44",
      total_count: 2,
      overdue_count: 0,
    });
    renderLight(<InstallmentsPanel />, { user: "admin" });
    await screen.findAllByText("总应收");

    const receivable = screen
      .getAllByText("总应收")
      .map((el) => el.closest(".ui-stat"))
      .find(Boolean);
    expect(receivable?.textContent).toContain("12,345.67");

    const paid = screen
      .getAllByText("已收合计")
      .map((el) => el.closest(".ui-stat"))
      .find(Boolean);
    expect(paid?.textContent).toContain("8,901.23");
  });

  it("已交付合约禁用「登记收款」，未结清合约禁用「换绑交付」", async () => {
    renderLight(<InstallmentsPanel />, { user: "admin" });
    await screen.findByText("HS0001-INS01");
    const payButtons = screen.getAllByRole("button", { name: /登记收款/ });
    const deliverButtons = screen.getAllByRole("button", { name: /换绑交付/ });
    // 列表按最新合约在前排序，按钮状态断言不依赖行序：ACTIVE 可收款、DELIVERED 禁收款。
    const payStates = payButtons.map((b) => (b as HTMLButtonElement).disabled);
    expect(payStates).toContain(false); // ACTIVE
    expect(payStates).toContain(true); // DELIVERED
    expect(deliverButtons.every((b) => (b as HTMLButtonElement).disabled)).toBe(true); // 都不是 SETTLED
  });

  it("SCHEDULED 合约已结清时「换绑交付」可点", async () => {
    vi.mocked(installmentsApi.list).mockResolvedValueOnce([{ ...installments[0], status: "SETTLED" }]);
    renderLight(<InstallmentsPanel />, { user: "admin" });
    await screen.findByText("HS0001-INS01");
    const deliverButtons = screen.getAllByRole("button", { name: /换绑交付/ });
    expect(deliverButtons.some((b) => !(b as HTMLButtonElement).disabled)).toBe(true);
  });

  it("FE-074：已结清合约禁止登记收款和终止退款", async () => {
    vi.mocked(installmentsApi.list).mockResolvedValueOnce([{ ...installments[0], status: "SETTLED" }]);
    renderLight(<InstallmentsPanel />, { user: "admin" });
    await screen.findByText("HS0001-INS01");
    expect(screen.getByRole("button", { name: /登记收款/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /终止分期并退款/ })).toBeDisabled();
  });
});

// —— 原 InstallmentsPanel.actions.test.tsx ——
// 原 .actions 文件；fixture 与主文件同名，整体收进独立 describe 隔离作用域。
// 三个文件都是同一页 + 同一份 catalog automock，拆开只让 jsdom+antd 启动重复付费。
describe("InstallmentsPanel：动作与减免", () => {
  let ui: ReturnType<typeof userEvent.setup>;

  const installments = [
    {
      id: 1,
      inst_no: "HS0001-INS01",
      contract_type: "STOCK_SALE",
      order_id: 10,
      down_payment: "100.00",
      principal: "300.00",
      service_fee: "0.00",
      per_period_service_fee: "0.00",
      per_period: "50.00",
      periods: 4,
      paid_amount: "150.00",
      total_receivable: "300.00",
      remaining_receivable: "100.00",
      status: "ACTIVE",
    },
    {
      id: 2,
      inst_no: "HS0002-INS01",
      contract_type: "STOCK_SALE",
      order_id: 10,
      down_payment: "0.00",
      principal: "200.00",
      service_fee: "0.00",
      per_period_service_fee: "0.00",
      per_period: "100.00",
      periods: 2,
      paid_amount: "200.00",
      total_receivable: "200.00",
      remaining_receivable: "0.00",
      status: "DELIVERED",
    },
  ];

  beforeEach(() => {
    ui = userEvent.setup({ pointerEventsCheck: 0 });
    vi.clearAllMocks();
    seedOrderFormFields();
    vi.mocked(installmentsApi.list).mockResolvedValue(installments);
    vi.mocked(installmentsApi.schedules).mockResolvedValue([
      { id: 1, installment_id: 1, period_no: 0, due_on: "2026-10-01", due_amount: "100.00", received_amount: "100.00", status: "PAID" },
    ]);
    vi.mocked(installmentsApi.dispositions).mockResolvedValue([]);
    vi.mocked(ordersApi.list).mockResolvedValue([{ id: 10, order_no: "HS-2026-0010", order_type: "HS", capital_type: "SELF", trade_date: "2026-10-01", status: "ACTIVE" }]);
  });

  describe("InstallmentsPanel：登记收款 / 换绑交付", () => {
    it("已有回收和转售记录时禁用重复处置", async () => {
      vi.mocked(installmentsApi.list).mockResolvedValueOnce([
        { ...installments[0], status: "OVERDUE" },
      ]);
      vi.mocked(installmentsApi.dispositions).mockResolvedValueOnce([
        { id: 1, installment_id: 1, account_id: 2, action: "RECOVER", occurred_on: "2026-10-12", note: "回收" },
        { id: 2, installment_id: 1, account_id: 2, action: "RESELL", occurred_on: "2026-10-13", note: "转售" },
      ]);
      renderLight(<InstallmentsPanel />, { user: "admin" });
      await screen.findByText("HS0001-INS01");
      expect(screen.getByRole("button", { name: /登记回收/ })).toBeDisabled();
      expect(screen.queryByRole("button", { name: /登记出售/ })).toBeNull();
    });

    it("登记收款提交后回传金额字符串与收款日期", async () => {
      resolveMockOnce(vi.mocked(installmentsApi.pay), { id: 1 });
      renderLight(<InstallmentsPanel />, { user: "admin" });
      await screen.findByText("HS0001-INS01");
      // 列表按最新合约在前，首个「登记收款」可能是 DELIVERED 禁用态 → 点击可用的那个
      const payButton = screen
        .getAllByRole("button", { name: /登记收款/ })
        .find((b) => !(b as HTMLButtonElement).disabled) as Element;
      await ui.click(payButton);
      await waitFor(() =>
        expect(document.querySelectorAll(".ant-modal-content").length).toBeGreaterThan(0),
      );
      const modal = document.querySelector(".ant-modal-content") as HTMLElement;
      await ui.type(modal.querySelector("#amount") as Element, "50.00");
      await ui.click(screen.getByRole("button", { name: /确认收款/ }));
      await waitFor(() => expect(vi.mocked(installmentsApi.pay)).toHaveBeenCalled());
      const [id, payload] = vi.mocked(installmentsApi.pay).mock.calls[0] as [number, Record<string, unknown>];
      expect(id).toBe(1);
      expect(payload.amount).toBe("50.00");
      expect(typeof payload.amount).toBe("string");
      expect(payload.paid_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("换绑交付：SETTLED 合约可打开弹窗，必填缺失时不提交", async () => {
      vi.mocked(installmentsApi.list).mockResolvedValueOnce([{ ...installments[0], status: "SETTLED" }]);
      renderLight(<InstallmentsPanel />, { user: "admin" });
      await screen.findByText("HS0001-INS01");
      await ui.click(screen.getAllByRole("button", { name: /换绑交付/ })[0] as Element);
      await waitFor(() =>
        expect(document.querySelectorAll(".ant-modal-content").length).toBeGreaterThan(0),
      );
      const modal = document.querySelector(".ant-modal-content") as HTMLElement;
      await ui.click(within(modal).getByRole("button", { name: /确认交付/ }));
      await waitFor(() => expect(vi.mocked(installmentsApi.deliver)).not.toHaveBeenCalled());
    });

    it("交付前可以登记退款并终止分期", async () => {
      const successSpy = vi.spyOn(message, "success");
      vi.mocked(installmentsApi.list).mockResolvedValueOnce([
        { ...installments[0], status: "ACTIVE" },
      ]);
      vi.mocked(installmentsApi.cancel).mockResolvedValueOnce({
        installment: { ...installments[0], status: "CANCELLED" },
        order_status: "CANCELLED",
        account_status: "WAITING",
        refund_amount: "50.00",
        reversed_amount: "0.00",
        cancel_event_ids: [3],
      });
      renderLight(<InstallmentsPanel />, { user: "admin" });
      await screen.findByText("HS0001-INS01");
      await ui.click(screen.getByRole("button", { name: /终止分期并退款/ }));
      const modal = document.querySelector(".ant-modal-content") as HTMLElement;
      await ui.type(within(modal).getByLabelText("取消原因"), "客户取消");
      await ui.click(within(modal).getByRole("button", { name: /确认退款并终止分期/ }));
      await waitFor(() => expect(vi.mocked(installmentsApi.cancel)).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ reason: "客户取消", cancelled_on: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }),
      ));
      expect(successSpy).toHaveBeenCalledWith("退款已登记：¥50.00，账号已回到库存");
      successSpy.mockRestore();
    });

    it("viewer 无 order.event.post → 收款/交付入口全部不渲染", async () => {
      renderLight(<InstallmentsPanel />, { user: "viewer" });
      await screen.findByText("HS0001-INS01");
      expect(screen.queryByRole("button", { name: /登记收款/ })).toBeNull();
      expect(screen.queryByRole("button", { name: /换绑交付/ })).toBeNull();
    });

    it("后端不可达 → 错误条落地", async () => {
      vi.mocked(installmentsApi.list).mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" });
      renderLight(<InstallmentsPanel />, { user: "admin" });
      await waitFor(() => expect(document.querySelector(".ant-alert")).toBeTruthy());
    });
  });
});

// —— 原 InstallmentsPanel.flows.test.tsx ——
// 原 .flows 文件；同上。
// 三个文件都是同一页 + 同一份 catalog automock，拆开只让 jsdom+antd 启动重复付费。
describe("InstallmentsPanel：剩余动作流加深", () => {
  const baseInstallment = {
    id: 1,
    inst_no: "HS0001-INS01",
    contract_type: "STOCK_SALE",
    order_id: 10,
    down_payment: "100.00",
    principal: "300.00",
    service_fee: "0.00",
    per_period_service_fee: "0.00",
    per_period: "50.00",
    periods: 4,
    paid_amount: "150.00",
    status: "ACTIVE",
    total_receivable: "300.00",
    remaining_receivable: "100.00",
    final_period_adjustment: "0.00",
    waived_amount: "0.00",
    bad_debt_amount: "0.00",
  };

  const order = {
    id: 10,
    order_no: "HS-2026-0010",
    order_type: "HS",
    capital_type: "SELF",
    account_business_mode: "SELF",
    account_game_type: "王者荣耀",
    account_game_account: "abc",
    party_name: "张三",
    trade_date: "2026-10-01",
    status: "ACTIVE",
  };

  /** 回收转售的出售订单：必须是新的售出订单（不能是分期来源单本身，后端强制）。 */
  const resaleOrder = { ...order, id: 20, order_no: "HS-2026-0020", party_name: "李四" };

  let ui: ReturnType<typeof userEvent.setup>;
  let successSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    ui = userEvent.setup({ pointerEventsCheck: 0 });
    successSpy = vi.spyOn(message, "success").mockImplementation(() => undefined as never);
    errorSpy = vi.spyOn(message, "error").mockImplementation(() => undefined as never);
    vi.clearAllMocks();
    seedOrderFormFields();
    vi.mocked(installmentsApi.list).mockResolvedValue([{ ...baseInstallment }]);
    vi.mocked(installmentsApi.schedules).mockResolvedValue([
      { id: 1, installment_id: 1, period_no: 0, due_on: "2026-10-01", due_amount: "100.00", received_amount: "100.00", status: "PENDING" },
    ]);
    vi.mocked(installmentsApi.dispositions).mockResolvedValue([]);
    vi.mocked(ordersApi.list).mockResolvedValue([order]);
  });

  afterEach(() => {
    successSpy.mockRestore();
    errorSpy.mockRestore();
  });

  /** 取当前可见（open）的 Modal 内容节点，按标题子串定位，避免命中关闭态的隐藏 Modal。 */
  function openModal(substr: string): HTMLElement {
    const modals = Array.from(document.querySelectorAll<HTMLElement>(".ant-modal-content"));
    const m = modals.find((el) => el.textContent?.includes(substr));
    if (!m) throw new Error(`modal not found: ${substr}`);
    return m;
  }

  describe("InstallmentsPanel：剩余动作流加深", () => {
    it("登记回收（OVERDUE 合约）提交调用 recover 并提示", async () => {
      vi.mocked(installmentsApi.list).mockResolvedValueOnce([
        { ...baseInstallment, status: "OVERDUE" },
      ]);
      renderLight(<InstallmentsPanel />, { user: "admin" });
      await screen.findByText("HS0001-INS01");
      await ui.click(screen.getByRole("button", { name: /登记回收/ }));
      const modal = openModal("逾期回收");
      await ui.clear(within(modal).getByLabelText("回收日期"));
      await ui.type(within(modal).getByLabelText("回收日期"), "2026-10-15");
      await ui.type(within(modal).getByLabelText("回收说明"), "逾期未付");
      await ui.click(within(modal).getByRole("button", { name: /确认回收/ }));
      await waitFor(() => expect(vi.mocked(installmentsApi.recover)).toHaveBeenCalledWith(
        1,
        { occurred_on: "2026-10-15", note: "逾期未付" },
      ));
      expect(successSpy).toHaveBeenCalledWith("逾期账号已登记回收");
    });

    it("提前结清提交调用 settleEarly 并提示", async () => {
      renderLight(<InstallmentsPanel />, { user: "admin" });
      await screen.findByText("HS0001-INS01");
      await ui.click(screen.getByRole("button", { name: /提前结清/ }));
      const modal = openModal("提前结清");
      await ui.clear(within(modal).getByLabelText("结清日期"));
      await ui.type(within(modal).getByLabelText("结清日期"), "2026-10-20{enter}");
      await ui.click(within(modal).getByRole("button", { name: /确认提前结清/ }));
      await waitFor(() => expect(vi.mocked(installmentsApi.settleEarly)).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ paid_on: "2026-10-20" }),
      ));
      expect(successSpy).toHaveBeenCalledWith("已提前结清，剩余应收一次性收清");
    });

    it("登记违约提交调用 markDefault 并提示", async () => {
      renderLight(<InstallmentsPanel />, { user: "admin" });
      await screen.findByText("HS0001-INS01");
      await ui.click(screen.getByRole("button", { name: /登记违约/ }));
      const modal = openModal("登记违约");
      await ui.type(within(modal).getByLabelText("违约原因"), "长期失联");
      await ui.click(within(modal).getByRole("button", { name: /确认登记违约/ }));
      await waitFor(() => expect(vi.mocked(installmentsApi.markDefault)).toHaveBeenCalledWith(
        1,
        { reason: "长期失联" },
      ));
      expect(successSpy).toHaveBeenCalledWith("已登记违约，合约进入 DEFAULTED");
    });

    it("期次减免（展开行）提交调用 waiveSchedule 并提示", async () => {
      renderLight(<InstallmentsPanel />, { user: "admin" });
      await screen.findByText("HS0001-INS01");
      const expand = document.querySelector(".ant-table-row-expand-icon") as HTMLElement;
      await ui.click(expand);
      const waiveBtn = await screen.findByRole("button", { name: /减免/ });
      await ui.click(waiveBtn);
      const modal = openModal("期次减免");
      await ui.type(within(modal).getByLabelText("减免金额"), "20.00");
      await ui.clear(within(modal).getByLabelText("减免日期"));
      await ui.type(within(modal).getByLabelText("减免日期"), "2026-10-21");
      await ui.type(within(modal).getByLabelText("减免原因"), "协商减免");
      await ui.click(within(modal).getByRole("button", { name: /确认减免/ }));
      await waitFor(() => expect(vi.mocked(installmentsApi.waiveSchedule)).toHaveBeenCalledWith(
        1,
        0,
        expect.objectContaining({ amount: "20.00", reason: "协商减免" }),
      ));
      expect(successSpy).toHaveBeenCalledWith("期次减免已登记");
    });

    it("期次展期（展开行）提交调用 extendSchedule 并提示", async () => {
      renderLight(<InstallmentsPanel />, { user: "admin" });
      await screen.findByText("HS0001-INS01");
      const expand = document.querySelector(".ant-table-row-expand-icon") as HTMLElement;
      await ui.click(expand);
      const extendBtn = await screen.findByRole("button", { name: /展期/ });
      await ui.click(extendBtn);
      const modal = openModal("期次展期");
      await ui.clear(within(modal).getByLabelText("新到期日"));
      await ui.type(within(modal).getByLabelText("新到期日"), "2026-11-30");
      await ui.type(within(modal).getByLabelText("展期原因"), "客户申请");
      await ui.click(within(modal).getByRole("button", { name: /确认展期/ }));
      await waitFor(() => expect(vi.mocked(installmentsApi.extendSchedule)).toHaveBeenCalledWith(
        1,
        0,
        expect.objectContaining({ new_due_on: "2026-11-30", reason: "客户申请" }),
      ));
      expect(successSpy).toHaveBeenCalledWith("期次展期已登记");
    });
    it("首屏加载一次分期列表（刷新入口已收敛到订单页/操作后自动重载）", async () => {
      renderLight(<InstallmentsPanel />, { user: "admin" });
      await screen.findByText("HS0001-INS01");
      expect(vi.mocked(installmentsApi.list)).toHaveBeenCalledTimes(1);
      // 逾期标记是全局动作，入口在订单页「分期与回款」Tab 的右上角，不在本面板内。
      expect(screen.queryByRole("button", { name: /标记逾期/ })).toBeNull();
      expect(screen.queryByRole("button", { name: /^刷新$/ })).toBeNull();
    });

    it("CLOSED 且已有回收记录 → 行内提供登记出售入口", async () => {
      vi.mocked(installmentsApi.list).mockResolvedValueOnce([
        { ...baseInstallment, status: "CLOSED" },
      ]);
      vi.mocked(installmentsApi.dispositions).mockResolvedValueOnce([
        { id: 1, installment_id: 1, account_id: 2, action: "RECOVER", occurred_on: "2026-10-12", note: "回收" },
      ]);
      renderLight(<InstallmentsPanel />, { user: "admin" });
      await screen.findByText("HS0001-INS01");
      expect(await screen.findByRole("button", { name: /登记出售/ })).toBeInTheDocument();
    });

    it("登记出售：选择出售订单并填写后调用 resale 关联", async () => {
      vi.mocked(installmentsApi.list).mockResolvedValueOnce([
        { ...baseInstallment, status: "CLOSED" },
      ]);
      vi.mocked(installmentsApi.dispositions).mockResolvedValueOnce([
        { id: 1, installment_id: 1, account_id: 2, action: "RECOVER", occurred_on: "2026-10-12", note: "回收" },
      ]);
      vi.mocked(ordersApi.list).mockResolvedValueOnce([order, resaleOrder]);
      vi.mocked(installmentsApi.resale).mockResolvedValue({
        id: 2, installment_id: 1, account_id: 2, action: "RESELL", occurred_on: "2026-10-20", related_order_id: 20, note: "转售",
      } as never);
      renderLight(<InstallmentsPanel />, { user: "admin" });
      await screen.findByText("HS0001-INS01");
      await ui.click(await screen.findByRole("button", { name: /登记出售/ }));
      const modal = openModal("登记出售");
      await ui.click(within(modal).getByRole("combobox", { name: /出售订单/ }));
      await ui.click(await within(document.body).findByText("HS-2026-0020 · 李四", { selector: ".ant-select-item-option-content" }));
      await ui.clear(within(modal).getByLabelText("出售日期"));
      await ui.type(within(modal).getByLabelText("出售日期"), "2026-10-20");
      await ui.type(within(modal).getByLabelText("出售说明"), "转售给下家");
      await ui.click(within(modal).getByRole("button", { name: /确认登记/ }));
      await waitFor(() => expect(vi.mocked(installmentsApi.resale)).toHaveBeenCalledWith(
        1,
        { resale_order_id: 20, occurred_on: "2026-10-20", note: "转售给下家" },
      ));
      expect(successSpy).toHaveBeenCalledWith("已登记出售，原分期与出售订单的利润关联保留");
    });

    it("收款提交失败 → Modal 内 InlineError 展示错误", async () => {
      vi.mocked(installmentsApi.pay).mockRejectedValueOnce(new Error("pay boom"));
      renderLight(<InstallmentsPanel />, { user: "admin" });
      await screen.findByText("HS0001-INS01");
      await ui.click(screen.getAllByRole("button", { name: /登记收款/ })[0] as Element);
      const modal = openModal("分期收款");
      await ui.type(within(modal).getByLabelText("本次实收"), "50.00");
      await ui.click(within(modal).getByRole("button", { name: /确认收款/ }));
      await waitFor(() => expect(within(modal).getByText(/pay boom/)).toBeInTheDocument());
      expect(vi.mocked(installmentsApi.pay)).toHaveBeenCalled();
    });

    it("P2-274：上一弹窗操作失败后，打开其它业务弹窗不残留旧错误", async () => {
      vi.mocked(installmentsApi.markDefault).mockRejectedValueOnce(new Error("default boom"));
      renderLight(<InstallmentsPanel />, { user: "admin" });
      await screen.findByText("HS0001-INS01");
      // 在「登记违约」弹窗触发失败，错误残留于共享 write.error
      await ui.click(screen.getByRole("button", { name: /登记违约/ }));
      const defaultModal = openModal("登记违约");
      await ui.type(within(defaultModal).getByLabelText("违约原因"), "长期失联");
      await ui.click(within(defaultModal).getByRole("button", { name: /确认登记违约/ }));
      await waitFor(() => expect(within(defaultModal).getByText(/default boom/)).toBeInTheDocument());
      // 注：motion-stub 下弹窗关闭动画不会收尾，A 弹窗在测试中仍可见、遮罩仍在；
      // pointerEventsCheck 已在本文件的 userEvent 配置中关闭，因此仍可直接切换到另一个弹窗。
      // 打开任一业务弹窗应清空共享错误态（含从 A 弹窗切到 B 弹窗的场景）。
      await ui.click(await screen.findByRole("button", { name: /提前结清/ }));
      const settleModal = openModal("提前结清");
      // 旧错误不应残留到新弹窗
      expect(within(settleModal).queryByText(/default boom/)).toBeNull();
    });
  });
});
