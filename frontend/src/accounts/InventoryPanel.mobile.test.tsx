import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MobileInventoryList } from "./InventoryPanel";
import { SessionProvider } from "../shared/state/session";
import type { Account } from "../shared/api/catalog";

// PermissionButton 依赖 useSession().can；单测里恒真放行，避免 dev 角色权限差异导致按钮不可见。
vi.mock("../shared/state/session", () => ({
  useSession: () => ({ can: () => true }),
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

function makeRow(over: Partial<Account> = {}): Account {
  return {
    id: 1,
    stock_no: "KU0001",
    game_account: "player01",
    source_order_no: "ORD-9",
    business_mode: "BUY",
    inventory_type: "SELF",
    value_added_service: "NONE",
    game_type: "PUBG",
    platform: "Steam",
    status: "IN_STOCK",
    cost_amount: "100.00",
    ...over,
  } as Account;
}

function renderCard(ui: React.ReactNode) {
  return render(<SessionProvider>{ui}</SessionProvider>);
}

describe("MobileInventoryList", () => {
  it("有数据时渲染卡片并展示全部字段标签", () => {
    renderCard(<MobileInventoryList rows={[makeRow()]} onSale={() => {}} onConsign={() => {}} onVoid={() => {}} onRebate={() => {}} onEdit={() => {}} onMoreAction={() => {}} editingAccount={null} />);
    expect(screen.getByText("KU0001")).toBeInTheDocument();
    for (const label of ["游戏账号", "订单号", "业务", "业务类型", "增值服务", "产品", "平台", "成本"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // 成本金额经 MoneyText 渲染
    expect(screen.getByText(/100\.00/)).toBeInTheDocument();
  });

  it("空数据渲染空态不报错", () => {
    renderCard(<MobileInventoryList rows={[]} onSale={() => {}} onConsign={() => {}} onVoid={() => {}} onRebate={() => {}} onEdit={() => {}} onMoreAction={() => {}} editingAccount={null} />);
    expect(screen.getByText("暂无账号")).toBeInTheDocument();
  });

  it("动作按钮可点击并回调对应 handler", async () => {
    const onSale = vi.fn();
    const onMoreAction = vi.fn();
    const user = userEvent.setup();
    renderCard(
      <MobileInventoryList
        rows={[makeRow({ inventory_type: "SELF", status: "IN_STOCK" })]}
        onSale={onSale}
        onConsign={() => {}}
        onVoid={() => {}}
        onRebate={() => {}}
        onEdit={() => {}}
        onMoreAction={onMoreAction}
        editingAccount={null}
      />,
    );
    await user.click(screen.getByText("售出"));
    expect(onSale).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });
});
