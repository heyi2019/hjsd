import { screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { appModal as Modal } from "../shared/ui/appFeedback";
import { CreateBusinessModal } from "./CreateBusinessModal";
import * as catalog from "../shared/api/catalog";
import { resolveMock } from "../test/mock-api";
import { seedOrderFormFields } from "../test/formFieldsSeed";

// 自动 mock：所有导出（含嵌套 ordersApi / orderTypesApi / ...）均为 vi.fn()
vi.mock("../shared/api/catalog");

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.clearAllMocks();
  seedOrderFormFields(catalog);
  vi.mocked(catalog.orderTypesApi.list).mockResolvedValue([{ id: 1, code: "HS", name: "回收", capital_type: "SELF", is_active: true }]);
  vi.mocked(catalog.customersApi.list).mockResolvedValue([{ id: 1, customer_no: "CUS-0001", display_name: "张三", status: "ACTIVE" }]);
  vi.mocked(catalog.counterpartiesApi.list).mockResolvedValue([{ id: 2, counterparty_no: "CP-0001", display_name: "同行甲", type: "PEER", status: "ACTIVE" }]);
  resolveMock(vi.mocked(catalog.stocksApi.list), [
    { id: 9, game_account: "recovery-account", business_mode: "SELF", inventory_type: "RECOVERY", status: "IN_STOCK", cost_amount: "0.00" },
  ]);
  resolveMock(vi.mocked(catalog.poolsApi.list), [{ id: 1, name: "主账户", code: "MAIN", status: "ACTIVE" }]);
  vi.mocked(catalog.gameTypesApi.list).mockResolvedValue([
    { id: 1, name: "王者荣耀", sort_order: 10, is_active: true, is_default: true },
  ]);
  vi.mocked(catalog.ordersApi.list).mockResolvedValue([]);
});

// antd 静态 Modal.confirm 渲染在 document.body 下，testing-library 的 cleanup 不覆盖，
// 会导致重试/后续用例出现多份 confirm 残留，需手动移除。
afterEach(() => {
  cleanup();
  // antd 静态 Modal.confirm 渲染在 document.body 下，testing-library 的 cleanup 不覆盖，
  // 重试/后续用例会残留多份 confirm（其异步挂载时机可能与 afterEach 清理错开）。
  document.body.querySelectorAll('[class*="ant-modal"]').forEach((el) => el.remove());
});

async function openTypedModal(orderType: string, onClose = vi.fn(), onCreated = vi.fn()) {
  renderLight(
    <CreateBusinessModal open onClose={onClose} onCreated={onCreated} initialOrderType={orderType as "HS" | "TH" | "DG" | "DFQ"} />,
    { user: "admin" },
  );
  const title = await screen.findByText(
    orderType === "HS" ? "新建回收订单" : orderType === "TH" ? "新建提号订单" : orderType === "DG" ? "新建代挂订单" : "新建代分期订单",
  );
  return { container: title.closest(".ant-modal-content") as HTMLElement, onClose, onCreated };
}

describe("CreateBusinessModal.deep：加载失败/取消确认/联动清除", () => {
  it("业务数据加载失败展示错误横幅（弹窗内无重试入口）", async () => {
    vi.mocked(catalog.customersApi.list).mockRejectedValue(new Error("load fail"));
    await openTypedModal("HS");
    expect((await screen.findAllByText(/load fail/)).length).toBeGreaterThan(0);
    // 组件未给 ErrorBanner 传 onRetry，故弹窗内无「重新加载」按钮；load 的 catch 分支已覆盖
    expect(screen.queryByText("重新加载")).toBeNull();
  });

  it("已填写表单点关闭触发放弃确认，确认后 onClose", async () => {
    const onClose = vi.fn();
    // antd 静态 Modal.confirm 在 jsdom 下 OK 按钮的 accessible name 无法稳定定位，
    // 用 spy 验证组件确实调用了 confirm 且 onOk 触发 onClose（覆盖 onCancel 分支）。
    const confirmSpy = vi.spyOn(Modal, "confirm").mockImplementation((config) => {
      (config as { onOk?: () => void }).onOk?.();
      return { destroy: () => undefined } as unknown as ReturnType<typeof Modal.confirm>;
    });
    await openTypedModal("HS", onClose);
    await ui.type(screen.getByLabelText("客户昵称"), "李四");
    await ui.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("客户来源改为可输入的选填文本框，不再有「其他来源」遗留子字段", async () => {
    await openTypedModal("HS");
    const source = screen.getByLabelText("客户来源") as HTMLInputElement;
    await ui.type(source, "朋友介绍");
    expect(source.value).toBe("朋友介绍");
    // 砍掉「其他来源」遗留分支后，建单弹窗内不应再出现该子字段
    expect(screen.queryByLabelText("其他来源")).toBeNull();
  });
});
