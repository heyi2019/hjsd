import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../../test/render";

import * as catalog from "../../shared/api/catalog";
vi.mock("../../shared/api/catalog");

describe("SequencesPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(catalog.sequencesApi.list).mockResolvedValue([
      { sequence_key: "ORDER_HS", prefix: "HJ-HS-", padding: 4, current_value: 128, next_number: "HJ-HS-0129" },
      { sequence_key: "CASHFLOW", prefix: "HJ-FL-", padding: 6, current_value: 4567, next_number: "HJ-FL-004568" },
    ]);
  });

  it("展示编号域的当前值与下一编号（只读，无写入口）", async () => {
    const { SequencesPanel } = await import("./SequencesPanel");
    renderLight(<SequencesPanel />, { user: "admin" });

    expect(await screen.findByText("HJ-HS-0129")).toBeInTheDocument();
    expect(screen.getByText("HJ-FL-004568")).toBeInTheDocument();
    // 编号域中文标签 + 原始序列键都可见，便于与后端 SequenceKey 枚举对照
    expect(screen.getAllByText("回收订单").length).toBeGreaterThan(0);
    expect(screen.getAllByText("ORDER_HS").length).toBeGreaterThan(0);
    // 只读面板：不提供任何新增/编辑/重置入口
    expect(screen.queryByRole("button", { name: /新建|编辑|重置|保存/ })).toBeNull();
  });

  it("加载失败时展示错误横幅（不静默）", async () => {
    vi.mocked(catalog.sequencesApi.list).mockRejectedValueOnce({
      isAxiosError: true,
      response: { data: { code: "INTERNAL", message: "编号序列加载失败" } },
      message: "Request failed",
    });
    const { SequencesPanel } = await import("./SequencesPanel");
    renderLight(<SequencesPanel />, { user: "admin" });

    expect(await screen.findByText("编号序列加载失败")).toBeInTheDocument();
  });
});
