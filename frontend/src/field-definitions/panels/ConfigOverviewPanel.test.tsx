/** ConfigOverviewPanel 测试：配置项清单渲染、计数与改动统计来源、跳转、明细加载、容错降级。 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as catalog from "../../shared/api/catalog";
vi.mock("../../shared/api/catalog");
import * as client from "../../shared/api/client";
import { renderLight } from "../../test/render";
import { CONFIG_GROUP_LABEL, SETTINGS_ITEMS } from "../configCatalog";
import { FORM_SCOPES } from "../formScopes";
import { ConfigOverviewPanel } from "./ConfigOverviewPanel";

vi.mock("../../shared/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/api/client")>()),
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
  login: vi.fn(),
  logout: vi.fn(),
  setDevUser: vi.fn(),
  changePassword: vi.fn(),
  checkBackendHealth: vi.fn(),
}));

const auditRow = (over: Partial<catalog.AuditLogRow> = {}): catalog.AuditLogRow => ({
  id: 1,
  actor: "admin",
  action: "UPDATE",
  entity_type: "order_form_field",
  entity_id: "5",
  occurred_at: "2026-10-26T10:00:00",
  reason: "调整必填",
  ...over,
});

let ui: ReturnType<typeof userEvent.setup>;

/** 取卡片内某个 Statistic 的显示值（标题与值分属不同节点，必须按 title 定位再取值）。 */
const statValue = (card: HTMLElement, title: string): string => {
  const node = within(card).getByText(title).closest(".ant-statistic") as HTMLElement;
  return node.querySelector(".ant-statistic-content-value")?.textContent?.trim() ?? "";
};

/** 让每个计数/审计 API 都有可用的解析值，个别用例再覆盖。 */
const seedHappyPath = () => {
  vi.mocked(catalog.auditApi).list.mockResolvedValue({ items: [], total: 0 });
  vi.mocked(catalog.auditApi).stats.mockResolvedValue([]);
  vi.mocked(catalog.orderFormFieldsApi).list.mockResolvedValue([]);
  vi.mocked(catalog.orderTypesApi).list.mockResolvedValue([]);
  vi.mocked(catalog.poolsApi).list.mockResolvedValue([]);
  vi.mocked(catalog.poolAccountsApi).list.mockResolvedValue([]);
  vi.mocked(catalog.periodLocksApi).list.mockResolvedValue([]);
  vi.mocked(catalog.qualityApi).list.mockResolvedValue({ items: [] } as never);
  vi.mocked(catalog.gameTypesApi).list.mockResolvedValue([]);
  vi.mocked(catalog.fieldsApi).list.mockResolvedValue([]);
  vi.mocked(catalog.policyApi).list.mockResolvedValue({ items: [], total: 0 });
  vi.mocked(catalog.sequencesApi).list.mockResolvedValue([]);
  vi.mocked(catalog.importsApi).batches.mockResolvedValue({ items: [], total: 0 });
  vi.mocked(client.api.get).mockResolvedValue({ data: [] } as never);
};

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.clearAllMocks();
  seedHappyPath();
});

describe("ConfigOverviewPanel", () => {
  it("渲染无权限门控的全部配置项与分组标题", async () => {
    const free = SETTINGS_ITEMS.filter((item) => !item.permission);
    renderLight(<ConfigOverviewPanel onNavigate={vi.fn()} />, { user: "admin" });

    await waitFor(() => expect(screen.getByText("表单字段")).toBeTruthy());
    for (const item of free) {
      expect(screen.getByText(item.label)).toBeTruthy();
    }
    // 分组标题按实际出现的分组渲染（不是写死的四五个）
    for (const groupLabel of new Set(free.map((item) => CONFIG_GROUP_LABEL[item.group]))) {
      expect(screen.getByText(groupLabel)).toBeTruthy();
    }
  });

  it("只读项打「只读」标签且按钮为「查看」", async () => {
    renderLight(<ConfigOverviewPanel onNavigate={vi.fn()} />, { user: "admin" });

    await waitFor(() => expect(screen.getAllByText("只读").length).toBeGreaterThan(0));
    expect(screen.getAllByText("查看").length).toBe(SETTINGS_ITEMS.filter((i) => i.readOnly).length);
  });

  it("卡片展示条目数与累计改动数（累计数取自 stats 而非 list 的 total）", async () => {
    vi.mocked(catalog.orderTypesApi).list.mockResolvedValue([
      { id: 1, code: "HS", name: "回收" },
      { id: 2, code: "TH", name: "提号" },
    ] as never);
    // list 的 total 只代表当页行数（limit=1 时恒为 1），真实累计数必须来自 stats
    vi.mocked(catalog.auditApi).list.mockResolvedValue({ items: [], total: 1 });
    vi.mocked(catalog.auditApi).stats.mockResolvedValue([
      { entity_type: "OrderTypeDef", count: 7, last_at: "2026-10-26T09:30:00", last_actor: "alice" },
    ]);

    renderLight(<ConfigOverviewPanel onNavigate={vi.fn()} />, { user: "admin" });

    await waitFor(() => expect(screen.getByText("业务类型")).toBeTruthy());
    // 只在该项卡片范围内断值，避免和顶部「可见配置项」等统计数字撞到一起
    const card = screen.getByText("业务类型").closest(".ant-card") as HTMLElement;
    expect(within(card).getByText("2")).toBeTruthy();
    expect(within(card).getByText("7")).toBeTruthy();
  });

  it("最近改动取 stats 返回的最近一条时间与人", async () => {
    vi.mocked(catalog.auditApi).stats.mockResolvedValue([
      { entity_type: "order_form_field", count: 3, last_at: "2026-10-26T09:30:00", last_actor: "heyi" },
    ]);

    renderLight(<ConfigOverviewPanel onNavigate={vi.fn()} />, { user: "admin" });

    expect(await screen.findByText("2026-10-26 09:30")).toBeTruthy();
    expect(screen.getByText(/最近由 heyi 修改/)).toBeTruthy();
  });

  it("资金池与资金池账户各自统计自己的改动，不把同一批 pool_account 记两遍", async () => {
    vi.mocked(catalog.poolsApi).list.mockResolvedValue([{ id: 1 }] as never);
    vi.mocked(catalog.poolAccountsApi).list.mockResolvedValue([{ id: 1 }, { id: 2 }] as never);
    vi.mocked(catalog.auditApi).stats.mockResolvedValue([
      { entity_type: "Pool", count: 3, last_at: "2026-10-20T10:00:00", last_actor: "admin" },
      { entity_type: "pool_account", count: 5, last_at: "2026-10-24T10:00:00", last_actor: "heyi" },
    ]);

    renderLight(<ConfigOverviewPanel onNavigate={vi.fn()} />, { user: "admin" });

    await waitFor(() => expect(screen.getByText("资金池账户")).toBeTruthy());
    const poolsCard = screen.getByText("资金池").closest(".ant-card") as HTMLElement;
    const accountsCard = screen.getByText("资金池账户").closest(".ant-card") as HTMLElement;
    expect(statValue(poolsCard, "改动")).toBe("3");
    expect(statValue(accountsCard, "改动")).toBe("5");
    expect(statValue(accountsCard, "条目")).toBe("2");
  });

  it("月结账期锁与质量异常议题进入总览清单", async () => {
    vi.mocked(catalog.periodLocksApi).list.mockResolvedValue([{ id: 1 }] as never);
    vi.mocked(catalog.qualityApi).list.mockResolvedValue({ items: [{ id: 1 }, { id: 2 }] } as never);

    renderLight(<ConfigOverviewPanel onNavigate={vi.fn()} />, { user: "admin" });

    await waitFor(() => expect(screen.getByText("月结账期锁")).toBeTruthy());
    expect(screen.getByText("质量异常议题")).toBeTruthy();
    const lockCard = screen.getByText("月结账期锁").closest(".ant-card") as HTMLElement;
    const qualityCard = screen.getByText("质量异常议题").closest(".ant-card") as HTMLElement;
    expect(statValue(lockCard, "条目")).toBe("1");
    expect(statValue(qualityCard, "条目")).toBe("2");
  });

  it("点「去配置」回调对应 Tab key", async () => {
    const onNavigate = vi.fn();
    renderLight(<ConfigOverviewPanel onNavigate={onNavigate} />, { user: "admin" });

    await waitFor(() => expect(screen.getAllByText("去配置").length).toBeGreaterThan(0));
    // 第一个「去配置」是表单字段（它们在 DOM 中按分组顺序排列）
    await ui.click(screen.getAllByText("去配置")[0]);
    expect(onNavigate).toHaveBeenCalledWith(SETTINGS_ITEMS[0].key);
  });

  it("加载明细后展示表单行，点行跳转并带作用域", async () => {
    vi.mocked(catalog.orderFormFieldsApi).list.mockImplementation((code: string) =>
      Promise.resolve(
        code === "SALE" ? [{ id: 1, is_active: false, required: true, is_custom: false }] : [{ id: 2, is_active: true, required: false, is_custom: false }],
      ) as never,
    );
    const onNavigate = vi.fn();
    renderLight(<ConfigOverviewPanel onNavigate={onNavigate} />, { user: "admin" });

    await waitFor(() => expect(screen.getByText("加载明细")).toBeTruthy());
    await ui.click(screen.getByText("加载明细"));

    expect(await screen.findByText("库存售出")).toBeTruthy();
    await waitFor(() =>
      expect(vi.mocked(catalog.orderFormFieldsApi).list).toHaveBeenCalledTimes(FORM_SCOPES.length),
    );

    await ui.click(screen.getByText("库存售出"));
    expect(onNavigate).toHaveBeenCalledWith("form-fields", { scope: "SALE" });
  });

  it("最近配置改动表把 entity_type 翻成配置域名", async () => {
    vi.mocked(catalog.auditApi).list.mockImplementation((params) =>
      Promise.resolve(
        params?.limit === 200
          ? {
              items: [auditRow({ entity_type: "GameTypeOption", action: "CREATE", entity_id: "9" })],
              total: 1,
            }
          : { items: [], total: 0 },
      ),
    );

    renderLight(<ConfigOverviewPanel onNavigate={vi.fn()} />, { user: "admin" });

    // 不能只断言「游戏类型」存在 —— 配置项卡片本身就是这个名字，翻译失效也会通过。
    // 必须锁定流水表那一行，并要求原始 entity_type 已不出现在页面上。
    await waitFor(() => expect(screen.queryAllByRole("row").length).toBeGreaterThan(1));
    const targetRow = screen.getAllByRole("row").find((row) => within(row).queryByText("9"));
    expect(targetRow).toBeTruthy();
    expect(within(targetRow as HTMLElement).getByText("游戏类型")).toBeTruthy();
    expect(screen.queryByText("GameTypeOption")).toBeNull();
    expect(screen.getAllByText("CREATE").length).toBeGreaterThan(0);
  });

  it("单个计数接口失败时该项降级为「—」且整页不崩", async () => {
    vi.mocked(catalog.poolsApi).list.mockRejectedValue(new Error("403"));
    vi.mocked(catalog.auditApi).stats.mockRejectedValue(new Error("500"));

    renderLight(<ConfigOverviewPanel onNavigate={vi.fn()} />, { user: "admin" });

    expect(await screen.findByText("资金池")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("配置总览加载失败")).toBeNull());
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});
