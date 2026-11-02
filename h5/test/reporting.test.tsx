import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { MobileReportCards } from "../reporting";
import { MoneyText } from "../../frontend/src/frontend/src/shared/ui";

type Row = {
  game_account: string;
  buy_amount: string;
  status: string;
};

const columns = [
  { title: "游戏账号/产品", dataIndex: "game_account" as const },
  { title: "买入", dataIndex: "buy_amount" as const, render: (v: string) => <MoneyText value={v} /> },
  { title: "状态", dataIndex: "status" as const, render: (v: string) => <span>{v}</span> },
];

describe("MobileReportCards", () => {
  it("将每行列映射为 .data-mobile-card，dt 取列标题、dd 取渲染值", () => {
    const rows: Row[] = [
      { game_account: "acc-1", buy_amount: "1200.00", status: "在库" },
      { game_account: "acc-2", buy_amount: "3400.50", status: "已售" },
    ];
    const { container, getAllByText } = render(
      <MobileReportCards<Row> rows={rows} columns={columns as never} />,
    );

    const cards = container.querySelectorAll(".data-mobile-card");
    expect(cards.length).toBe(2);

    // 第一张卡片含全部列标签
    const firstLabels = Array.from(cards[0].querySelectorAll("dt")).map((d) => d.textContent);
    expect(firstLabels).toEqual(["游戏账号/产品", "买入", "状态"]);

    // 数据值正确呈现（含 MoneyText 渲染的金额与 render 后的状态）
    expect(getAllByText("acc-1").length).toBeGreaterThanOrEqual(1);
    expect(getAllByText("在库").length).toBeGreaterThanOrEqual(1);
    // MoneyText 把 1200.00 格式化为 1,200.00
    expect(getAllByText(/1,200\.00/).length).toBeGreaterThanOrEqual(1);
  });

  it("空数据时渲染空列表（不报错）", () => {
    const { container } = render(<MobileReportCards<Row> rows={[]} columns={columns as never} />);
    expect(container.querySelectorAll(".data-mobile-card").length).toBe(0);
    expect(container.querySelector(".data-mobile-list")).not.toBeNull();
  });
});
