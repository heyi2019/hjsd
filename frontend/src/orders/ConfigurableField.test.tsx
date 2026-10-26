/** ConfigurableField 测试：
 *  - resolveRules 必填下限语义（纯函数）；
 *  - CustomFormField 按类型渲染并把值归集到 form_extra.<field_key>；
 *  - CfgItem 在 FieldConfigContext 驱动下：停用字段不渲染、启用字段读配置标签。
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { Form, Input, Radio, Select } from "antd";
import type { OrderFormField } from "../shared/api/catalog";
import { renderLight } from "../test/render";
import {
  CfgItem,
  CustomFormField,
  FieldConfigContext,
  injectOptionsIfMissing,
  resolveOptionItems,
  resolveRules,
  type FieldConfigMap,
} from "./ConfigurableField";

const makeField = (over: Partial<OrderFormField> = {}): OrderFormField => ({
  id: 1,
  order_type_code: "HS",
  field_key: "k",
  label: "字段",
  field_type: "TEXT",
  options: null,
  required: false,
  is_active: true,
  sort_order: 0,
  locked: false,
  is_custom: true,
  note: null,
  ...over,
});

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.clearAllMocks();
});

describe("resolveRules 必填下限语义", () => {
  const base = [{ required: true, message: "基础必填" }] as Record<string, unknown>[];

  it("无配置返回基础规则", () => {
    expect(resolveRules({}, "x", base as never)).toEqual(base);
  });

  it("配置 required=true 且基础已有必填时不重复追加", () => {
    const cfg: FieldConfigMap = { x: makeField({ field_key: "x", required: true }) };
    const out = resolveRules(cfg, "x", base as never);
    const requiredCount = out.filter((r) => (r as { required?: boolean }).required).length;
    expect(requiredCount).toBe(1);
  });

  it("配置 required=true 且基础无必填时追加必填规则", () => {
    const cfg: FieldConfigMap = { x: makeField({ field_key: "x", label: "字段X", required: true }) };
    const out = resolveRules(cfg, "x", [{ message: "其它" }] as never);
    const hit = out.some(
      (r) => (r as { required?: boolean }).required && (r as { message?: string }).message === "字段X必填",
    );
    expect(hit).toBe(true);
  });

  it("配置 required=false 保留基础规则不剥离", () => {
    const cfg: FieldConfigMap = { x: makeField({ field_key: "x", required: false }) };
    const out = resolveRules(cfg, "x", base as never);
    const requiredCount = out.filter((r) => (r as { required?: boolean }).required).length;
    expect(requiredCount).toBe(1);
  });
});

describe("CustomFormField", () => {
  it("TEXT 字段值归集到 form_extra.<field_key>", async () => {
    const def = makeField({ field_key: "vip_tag", label: "VIP标签", field_type: "TEXT", required: false });
    let captured: Record<string, unknown> | null = null;
    const Harness = () => {
      const [form] = Form.useForm();
      return (
        <Form
          form={form}
          onFinish={(v) => {
            captured = v;
          }}
        >
          <CustomFormField def={def} />
          <button type="submit">提交</button>
        </Form>
      );
    };
    renderLight(<Harness />);
    await ui.type(screen.getByLabelText("VIP标签"), "黄金");
    await ui.click(screen.getByRole("button", { name: "提交" }));
    await waitFor(() => expect(captured).not.toBeNull());
    expect((captured as unknown as { form_extra: Record<string, unknown> }).form_extra.vip_tag).toBe("黄金");
  });

  it("必填自定义字段未填时抛校验", async () => {
    const def = makeField({ field_key: "must", label: "必填项", field_type: "TEXT", required: true });
    const Harness = () => {
      const [form] = Form.useForm();
      return (
        <Form form={form} onFinish={() => undefined}>
          <CustomFormField def={def} />
          <button type="submit">提交</button>
        </Form>
      );
    };
    renderLight(<Harness />);
    await ui.click(screen.getByRole("button", { name: "提交" }));
    expect(await screen.findByText("必填项必填")).toBeInTheDocument();
  });

  it("SELECT 字段渲染选项控件", () => {
    const def = makeField({
      field_key: "src",
      label: "来源",
      field_type: "SELECT",
      options: ["微信", "支付宝"],
    });
    renderLight(
      <Form>
        <CustomFormField def={def} />
      </Form>,
    );
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("BOOLEAN 字段渲染开关控件", () => {
    const def = makeField({ field_key: "flag", label: "标记", field_type: "BOOLEAN" });
    renderLight(
      <Form>
        <CustomFormField def={def} />
      </Form>,
    );
    expect(screen.getByRole("switch")).toBeInTheDocument();
  });
});

describe("CfgItem 配置门控", () => {
  it("字段停用(is_active=false)时不渲染", () => {
    const cfg: FieldConfigMap = {
      game_account: makeField({ field_key: "game_account", label: "游戏账号", is_active: false }),
    };
    renderLight(
      <Form>
        <FieldConfigContext.Provider value={cfg}>
          <CfgItem name="game_account" label="游戏账号" rules={[]}>
            <Input />
          </CfgItem>
        </FieldConfigContext.Provider>
      </Form>,
    );
    expect(screen.queryByText("游戏账号")).not.toBeInTheDocument();
  });

  it("字段启用时渲染并读取配置标签", () => {
    const cfg: FieldConfigMap = {
      game_account: makeField({ field_key: "game_account", label: "账号(配置)", is_active: true }),
    };
    renderLight(
      <Form>
        <FieldConfigContext.Provider value={cfg}>
          <CfgItem name="game_account" label="游戏账号" rules={[]}>
            <Input />
          </CfgItem>
        </FieldConfigContext.Provider>
      </Form>,
    );
    expect(screen.getByText("账号(配置)")).toBeInTheDocument();
  });
});

describe("resolveOptionItems：选项归一化", () => {
  it("字符串数组 → {value,label} 同值", () => {
    expect(resolveOptionItems(["微信", "支付宝"])).toEqual([
      { value: "微信", label: "微信" },
      { value: "支付宝", label: "支付宝" },
    ]);
  });
  it("{value,label} 对象原样保留", () => {
    expect(resolveOptionItems([{ value: "BUY", label: "买号返点" }])).toEqual([
      { value: "BUY", label: "买号返点" },
    ]);
  });
  it("null/undefined → 空数组", () => {
    expect(resolveOptionItems(null)).toEqual([]);
    expect(resolveOptionItems(undefined)).toEqual([]);
  });
});

describe("injectOptionsIfMissing：未传 options 时从配置注入", () => {
  const def = makeField({
    field_key: "src",
    field_type: "SELECT",
    options: [{ value: "a", label: "A" }, { value: "b", label: "B" }],
  });

  // injectOptionsIfMissing 用 Children.map 包裹，返回可能是数组（注入时）或单元素（提前返回原 children 时）。
  const firstProps = (out: unknown) => {
    const el = (Array.isArray(out) ? out[0] : out) as ReactElement;
    return (el.props as { options?: unknown }).options;
  };

  it("Select 未传 options 时注入配置选项", () => {
    expect(firstProps(injectOptionsIfMissing(<Select />, def))).toEqual([
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ]);
  });

  it("Radio.Group 未传 options 时注入配置选项", () => {
    expect(firstProps(injectOptionsIfMissing(<Radio.Group />, def))).toEqual([
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ]);
  });

  it("Select 已显式传 options 时不覆盖（动态数据源）", () => {
    const explicit = [{ value: "x", label: "X" }];
    expect(firstProps(injectOptionsIfMissing(<Select options={explicit} />, def))).toEqual(explicit);
  });

  it("配置无 options 时不注入", () => {
    expect(firstProps(injectOptionsIfMissing(<Select />, makeField({ field_key: "x" })))).toBeUndefined();
  });
});
