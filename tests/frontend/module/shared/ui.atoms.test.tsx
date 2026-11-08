/** 共享展示组件的用户可见语义与关键交互。 */
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { MoneyText } from "@/shared/ui/MoneyText";
import { StatusTag } from "@/shared/ui/StatusTag";
import { EntryCard } from "@/shared/ui/EntryCard";
import { StatRow } from "@/shared/ui/StatCard";
import { ErrorBanner } from "@/shared/ui/ErrorBanner";
import { BusinessActionModal } from "@/shared/ui/BusinessActionModal";
import { CompactActions } from "@/shared/ui/CompactActions";
import { Select } from "@/shared/ui/Select";
import { dateValueFromEvent, dateValueProps } from "@/shared/ui/DateField";

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

describe("MoneyText：金额只展示，不做浮点运算", () => {
  it("字符串金额按千分位两位小数展示", () => {
    render(<MoneyText value="1234567.891" />);
    expect(screen.getByText("1,234,567.89")).toBeInTheDocument();
  });

  it("空值显示 -", () => {
    const { container } = render(<MoneyText value={null} />);
    expect(container.textContent).toBe("-");
  });

  it("0.1 与 0.2 分别展示为 0.10 / 0.20（证明前端没有做加法）", () => {
    const { container: a } = render(<MoneyText value="0.1" />);
    const { container: b } = render(<MoneyText value="0.2" />);
    expect(a.textContent).toBe("0.10");
    expect(b.textContent).toBe("0.20");
  });
});

describe("StatusTag：文案承载语义，颜色只是辅助", () => {
  it("已知状态渲染中文标签", () => {
    render(<StatusTag status="ACTIVE" />);
    expect(screen.getByText("进行中")).toBeInTheDocument();
  });

  it("通用 PENDING 只表示待结算，不再表示账号待入库", () => {
    render(<StatusTag status="PENDING" />);
    expect(screen.getByText("待结算")).toBeInTheDocument();
  });

  it("未知状态回落到原始状态码（不显示空白）", () => {
    render(<StatusTag status="SOME_NEW_STATUS" />);
    expect(screen.getByText("SOME_NEW_STATUS")).toBeInTheDocument();
  });

  it("传入 label 时以 label 为准", () => {
    render(<StatusTag status="ACTIVE" label="自定义" />);
    expect(screen.getByText("自定义")).toBeInTheDocument();
  });

  it("10 个后端核心状态枚举必须都有中文文案（守卫规则⑦ 的运行时兜底）", () => {
    const coreStatuses = [
      "DRAFT",
      "ACTIVE",
      "COMPLETED",
      "CANCELLED",
      "PENDING",
      "OVERDUE",
      "SETTLED",
      "DEFAULTED",
      "DELIVERED",
      "IN_STOCK",
    ];
    const { container, unmount } = render(<div />);
    unmount();
    for (const status of coreStatuses) {
      const { container: box } = render(<StatusTag status={status} />);
      const text = box.textContent ?? "";
      // 回落实现是「原样显示状态码」，因此文案等于状态码即代表漏配
      expect(text).not.toBe(status);
      expect(text.length).toBeGreaterThan(0);
    }
    expect(container).toBeTruthy();
  });

  it("导入批次状态（MIG-01）有中文文案", () => {
    render(<StatusTag status="UNMAPPED" />);
    expect(screen.getByText("未映射")).toBeInTheDocument();
  });

  it("金额相关状态不影响渲染（组件不参与金额计算）", () => {
    renderLight(<StatusTag status="PARTIALLY_SETTLED" />);
    expect(screen.getByText("部分结算")).toBeInTheDocument();
  });
});

describe("EntryCard：可点击入口卡", () => {
  it("点击触发 onClick", async () => {
    const onClick = vi.fn();
    render(<EntryCard title="订单总数" value="72" description="点击进入业务中心" onClick={onClick} />);
    expect(screen.getByText("订单总数")).toBeInTheDocument();
    expect(screen.getByText("72")).toBeInTheDocument();
    await ui.click(screen.getByRole("button", { name: /订单总数/ }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("键盘可达：Enter 与空格都能触发（div+role=button 不自发响应）", async () => {
    const onClick = vi.fn();
    render(<EntryCard title="新建业务" description="打开登记弹窗" onClick={onClick} />);
    const card = screen.getByRole("button", { name: /新建业务/ });
    card.focus();
    await ui.keyboard("{Enter}");
    await ui.keyboard(" ");
    expect(onClick).toHaveBeenCalledTimes(2);
  });

});

describe("StatRow：金额与计数不能混", () => {
  it("kind=money → 千分位两位小数", () => {
    render(<StatRow items={[{ label: "成交额", amount: "1234.5", kind: "money" }]} />);
    expect(screen.getByText("1,234.50")).toBeInTheDocument();
  });

  it("kind=count → 原样显示，不加小数（订单数不能被当成金额）", () => {
    render(<StatRow items={[{ label: "订单数", amount: 14565, kind: "count" }]} />);
    expect(screen.getByText("14565")).toBeInTheDocument();
  });

  it("缺失金额显示 -，不显示 0", () => {
    render(
      <StatRow
        items={[
          { label: "成交额", amount: null },
          { label: "订单数", amount: undefined },
        ]}
      />,
    );
    expect(screen.getAllByText("-")).toHaveLength(2);
  });

});

describe("ErrorBanner：给可执行下一步，不只复述报错", () => {
  it("有错误码时同时给出文案与处置提示", () => {
    render(<ErrorBanner error={{ message: "缺少资金池路由", code: "POOL_ROUTE_MISSING" }} />);
    expect(screen.getByText("缺少资金池路由")).toBeInTheDocument();
    expect(screen.getByText(/设置 → 主数据/)).toBeInTheDocument();
  });

  it("未知错误码不显示 hint，但 message 仍在", () => {
    const { container } = render(<ErrorBanner error={{ message: "未知错误", code: "WHATEVER" }} />);
    expect(screen.getByText("未知错误")).toBeInTheDocument();
    expect(container.querySelector(".ant-alert-description")).toBeNull();
  });

  it("权限类错误给出「联系管理员」而非让用户重试", () => {
    render(
      <ErrorBanner
        error={{ message: "无权限", code: "PERMISSION_DENIED" }}
        onRetry={() => undefined}
      />,
    );
    expect(screen.getByText(/联系管理员/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重新加载" })).not.toBeInTheDocument();
  });

  it("可恢复错误提供重新加载动作", () => {
    const onRetry = () => undefined;
    render(<ErrorBanner error={{ message: "后端不可达" }} onRetry={onRetry} />);
    expect(screen.getByRole("button", { name: /重新加载/ })).toBeInTheDocument();
  });
});

describe("CompactActions", () => {
  it("渲染确认子节点与右侧「取消」按钮", () => {
    renderLight(
      <CompactActions onCancel={vi.fn()}>
        <button type="submit">确认锁定</button>
      </CompactActions>,
    );

    expect(screen.getByText("确认锁定")).toBeInTheDocument();
    const cancel = screen.getByText("取消").closest("button");
    expect(cancel).toBeTruthy();
  });

  it("点击「取消」走显式 onCancel prop（优先级最高）", () => {
    const onCancel = vi.fn();
    renderLight(
      <CompactActions onCancel={onCancel}>
        <button type="submit">确认</button>
      </CompactActions>,
    );

    fireEvent.click(screen.getByText("取消").closest("button")!);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("无显式 onCancel 时回落到 ModalCancelContext（弹窗内用法）", () => {
    const onCancel = vi.fn();
    renderLight(
      <BusinessActionModal open onCancel={onCancel} title="锁定账期">
        <CompactActions>
          <button type="submit">确认锁定</button>
        </CompactActions>
      </BusinessActionModal>,
      { user: "admin" },
    );

    // CompactActions 在弹窗 children 作用域内，应取到 BusinessActionModal 下发的 onCancel。
    fireEvent.click(screen.getByText("取消").closest("button")!);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("Select：关闭虚拟列表", () => {
  const MANY = Array.from({ length: 20 }, (_, i) => ({ value: `v${i}`, label: `选项${i}` }));

  it("关闭虚拟列表后，全部选项渲染进 DOM（辅助树完整）", async () => {
    const user = userEvent.setup();
    renderLight(<Select options={MANY} placeholder="请选择" />, { user: "admin" });

    await user.click(screen.getByText("请选择").closest(".ant-select-selector")!);

    // 全部 20 个选项都应在 DOM 中（虚拟列表开启时只渲染可视区子集）
    const rendered = document.querySelectorAll(".ant-select-item-option");
    expect(rendered.length).toBe(MANY.length);
    for (let i = 0; i < MANY.length; i += 1) {
      expect(screen.getByText(`选项${i}`)).toBeInTheDocument();
    }
  });
});

describe("DateField value mapping", () => {
  it("将接口日期字符串映射为日期控件值", () => {
    expect(dateValueProps("2026-11-02").value?.format("YYYY-MM-DD")).toBe("2026-11-02");
    expect(dateValueProps(undefined).value).toBeNull();
  });

  it("将日期控件值转换回接口需要的日期字符串", () => {
    expect(dateValueFromEvent({ format: () => "2026-11-02" } as never)).toBe("2026-11-02");
    expect(dateValueFromEvent(null)).toBeUndefined();
  });
});
