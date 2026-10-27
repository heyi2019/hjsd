import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../../test/render";

import * as catalog from "../../shared/api/catalog";
vi.mock("../../shared/api/catalog");

describe("SequencesPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(catalog.sequencesApi.list).mockResolvedValue([
      { sequence_key: "ORDER_HS", prefix: "HS", padding: 4, current_value: 128, next_number: "HS0129" },
      { sequence_key: "CASHFLOW_OUT", prefix: "ZC", padding: 5, current_value: 7, next_number: "ZC00008" },
    ]);
  });

  it("展示编号域的当前值与下一编号（只读，无写入口）", async () => {
    const { SequencesPanel } = await import("./SequencesPanel");
    renderLight(<SequencesPanel />, { user: "admin" });

    // 分组 + 条目：下一编号出现在「加粗名称：说明」行内；流水编号带 padding 位数
    expect(await screen.findByText(/HS0129/)).toBeInTheDocument();
    expect(screen.getByText(/ZC\+5位流水/)).toBeInTheDocument();
    expect(screen.getByText(/ZC00008/)).toBeInTheDocument();
    // 编号域中文标签可见；分组标签与业务字典一致
    expect(screen.getAllByText("回收编号").length).toBeGreaterThan(0);
    expect(screen.getAllByText("支出流水").length).toBeGreaterThan(0);
    // 静态口径条目：库存编号 / 分期合约编号（非独立发放域，无 document_sequences 行也展示）
    expect(screen.getByText("库存编号")).toBeInTheDocument();
    expect(screen.getByText("分期合约编号")).toBeInTheDocument();
    expect(screen.getByText(/自营分期合约使用分期订单号衍生/)).toBeInTheDocument();
    // 只读面板：不提供任何新增/编辑/重置入口
    expect(screen.queryByRole("button", { name: /新建|编辑|重置|保存/ })).toBeNull();
  });

  it("静态分组外的动态编号域落入「自定义编号域」兜底组（不静默丢失）", async () => {
    vi.mocked(catalog.sequencesApi.list).mockResolvedValue([
      { sequence_key: "ORDER_HS", prefix: "HS", padding: 4, current_value: 128, next_number: "HS0129" },
      { sequence_key: "ORDER_QA5B", prefix: "QA5B", padding: 4, current_value: 0, next_number: "QA5B0001" },
    ]);
    const { SequencesPanel } = await import("./SequencesPanel");
    renderLight(<SequencesPanel />, { user: "admin" });

    expect(await screen.findByText("自定义编号域")).toBeInTheDocument();
    expect(screen.getByText(/QA5B0001/)).toBeInTheDocument();
    // 分组内已覆盖的域不重复出现在兜底组
    expect(screen.getAllByText(/HS0129/).length).toBe(1);
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
