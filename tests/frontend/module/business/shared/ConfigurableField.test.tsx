/** ConfigurableField 测试：
 *  - resolveRules 必填以配置为最终口径（纯函数）；
 *  - CustomFormField 按类型渲染并把值归集到 form_extra.<field_key>；
 *  - CfgItem 在 FieldConfigContext 驱动下：停用字段不渲染、启用字段读配置标签。
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { useState } from "react";
import { Form, Input, Radio } from "antd";
import type { OrderFormField } from "@/shared/api/types/forms";
import { Select } from "@/shared/ui";
import { renderLight } from "@fixtures/render";
import { splitFormExtra } from "@/business/shared/order-create/create/submit-helpers";
import {
  CfgItem,
  CfgNestedItem,
  CustomFieldSection,
  CustomFieldSections,
  CustomFieldSectionsProvider,
  CustomFormField,
  FieldConfigContext,
  SectionLabelsContext,
  fieldLabel,
  injectOptionsIfMissing,
  isConditionActive,
  useConditionFieldValue,
  resolveOptionItems,
  resolveRules,
  sectionLabel,
  buildFormExtraDisplay,
  type FieldConfigMap,
} from "@/shared/forms/ConfigurableField";

it("嵌套表单的必填字段标签显示星号", () => {
  renderLight(
    <Form>
      <CfgNestedItem name="required_field" label="必填字段" rules={[{ required: true }]}>
        <Input />
      </CfgNestedItem>
    </Form>,
  );
  expect(screen.getByText("*", { selector: ".form-field__required-mark" })).toBeInTheDocument();
});

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

it("切换条件依赖后，即使新值等于旧字段值也能更新", async () => {
  function Probe() {
    const [field, setField] = useState("first");
    const value = useConditionFieldValue(field);
    return <><button type="button" onClick={() => setField("second")}>切换依赖</button><span>{`当前:${value}`}</span></>;
  }
  renderLight(<Form initialValues={{ first: "1", second: "2" }}>
    <Form.Item name="first"><Input /></Form.Item>
    <Form.Item name="second"><Input aria-label="第二字段" /></Form.Item>
    <Probe />
  </Form>);
  expect(await screen.findByText("当前:1")).toBeInTheDocument();
  await ui.click(screen.getByRole("button", { name: "切换依赖" }));
  expect(screen.getByText("当前:2")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("第二字段"), { target: { value: "1" } });
  expect(await screen.findByText("当前:1")).toBeInTheDocument();
});

it("设置字段状态时不误报循环引用", async () => {
  const consoleError = vi.spyOn(console, "error");
  function Probe() {
    const [form] = Form.useForm();
    return <Form form={form}>
      <Form.Item name="note" label="说明" rules={[{ required: true, message: "请填写说明" }]}><Input /></Form.Item>
      <button type="button" onClick={() => form.setFieldsValue({ note: "初值" })}>初始化</button>
      <button type="button" onClick={() => form.setFields([{ name: "note", value: "已填写", errors: [], warnings: [] }])}>设置值</button>
    </Form>;
  }
  renderLight(<Probe />);
  await ui.click(screen.getByRole("button", { name: "初始化" }));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "设置值" })); });
  expect(screen.getByLabelText("说明")).toHaveValue("已填写");
  expect(consoleError.mock.calls.flat().join(" ")).not.toContain("There may be circular references");
  consoleError.mockRestore();
});

it.each([
  ["普通字段", "必填"], ["嵌套字段", "必填"], ["自定义字段", "必填"],
  ["普通字段", "条件必填"], ["嵌套字段", "条件必填"], ["自定义字段", "条件必填"],
])("%s 的配置%s文本不能仅输入空白", async (kind, mode) => {
  const def = makeField({ field_key: "detail", label: "说明", field_type: "TEXT", required: mode === "必填",
    required_when: mode === "条件必填" ? { field: "trigger", op: "filled" } : null });
  const onFinish = vi.fn();
  renderLight(
    <FieldConfigContext.Provider value={{ detail: def }}>
      <Form onFinish={onFinish} initialValues={{ trigger: "已填写" }}>
        <Form.Item name="trigger" hidden><Input /></Form.Item>
        {kind === "普通字段" ? <CfgItem name="detail" label="说明"><Input placeholder="填写说明" /></CfgItem>
          : kind === "嵌套字段" ? <CfgNestedItem name="detail" label="说明"><Input placeholder="填写说明" /></CfgNestedItem>
            : <CustomFormField def={def} />}
        <button type="submit">提交</button>
      </Form>
    </FieldConfigContext.Provider>,
  );
  const input = kind === "自定义字段" ? screen.getByLabelText("说明") : screen.getByPlaceholderText("填写说明");
  await ui.type(input, "   ");
  await ui.click(screen.getByRole("button", { name: "提交" }));
  await waitFor(() => expect(onFinish).not.toHaveBeenCalled());
  expect(input).toHaveAttribute("aria-invalid", "true");
});

it("选填文本仍可留空白", async () => {
  const def = makeField({ field_key: "detail", label: "说明", field_type: "TEXT", required: false });
  const onFinish = vi.fn();
  renderLight(<FieldConfigContext.Provider value={{ detail: def }}><Form onFinish={onFinish}>
    <CfgItem name="detail" label="说明"><Input /></CfgItem>
    <button type="submit">提交</button>
  </Form></FieldConfigContext.Provider>);
  await ui.type(screen.getByLabelText("说明"), "   ");
  await ui.click(screen.getByRole("button", { name: "提交" }));
  await waitFor(() => expect(onFinish).toHaveBeenCalledOnce());
});

describe("resolveRules 必填以配置为最终口径", () => {
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

  it("配置 required=false 剥离基础规则中的必填项（设置选填生效）", () => {
    const cfg: FieldConfigMap = { x: makeField({ field_key: "x", required: false }) };
    const out = resolveRules(cfg, "x", base as never);
    const requiredCount = out.filter((r) => (r as { required?: boolean }).required).length;
    expect(requiredCount).toBe(0);
  });

  it("配置 required=false 时保留金额格式等非必填校验器", () => {
    const cfg: FieldConfigMap = { amount: makeField({ field_key: "amount", required: false }) };
    const moneyValidator = { validator: vi.fn() };
    const out = resolveRules(cfg, "amount", [
      { required: true, message: "请输入金额" },
      moneyValidator,
    ] as never);
    expect(out).toEqual([moneyValidator]);
  });
});

describe("resolveRules 金额字段必填 > 0（选填可 0 / 必填不可 0）", () => {
  const moneyValidatorOf = (
    rules: unknown,
  ): ((r: unknown, v: unknown) => Promise<unknown>) | undefined => {
    const list = rules as Array<{ validator?: (r: unknown, v: unknown) => Promise<unknown> }>;
    return list.find((r) => typeof r.validator === "function")?.validator;
  };
  const validate = async (rules: unknown, value: unknown): Promise<string> => {
    const v = moneyValidatorOf(rules);
    if (!v) return "no-validator";
    try {
      await v(undefined, value);
      return "pass";
    } catch (e) {
      return (e as Error).message;
    }
  };

  it("必填 NUMBER 字段填 0 被拒（必填不可以为 0）", async () => {
    const cfg: FieldConfigMap = {
      price: makeField({ field_key: "price", label: "账号号价", field_type: "NUMBER", required: true }),
    };
    expect(await validate(resolveRules(cfg, "price", []), 0)).toContain("必须大于 0");
    const sorting: FieldConfigMap = {
      sort_order: makeField({ order_type_code: "SYSGAME", field_key: "sort_order", label: "排序", field_type: "NUMBER", required: true }),
    };
    expect(await validate(resolveRules(sorting, "sort_order", []), 0)).toBe("no-validator");
  });

  it("必填 NUMBER 字段填负数被拒", async () => {
    const cfg: FieldConfigMap = {
      price: makeField({ field_key: "price", label: "账号号价", field_type: "NUMBER", required: true }),
    };
    expect(await validate(resolveRules(cfg, "price", []), -50)).toContain("必须大于 0");
  });

  it("必填 NUMBER 字段填正数通过", async () => {
    const cfg: FieldConfigMap = {
      price: makeField({ field_key: "price", label: "账号号价", field_type: "NUMBER", required: true }),
    };
    expect(await validate(resolveRules(cfg, "price", []), 100)).toBe("pass");
  });

  it("选填 NUMBER 字段不挂载金额校验（选填可以 0）", () => {
    const cfg: FieldConfigMap = {
      price: makeField({ field_key: "price", label: "账号号价", field_type: "NUMBER", required: false }),
    };
    expect(moneyValidatorOf(resolveRules(cfg, "price", []))).toBeUndefined();
  });

  it("必填 TEXT 字段不加金额校验（非 NUMBER 不受影响）", () => {
    const cfg: FieldConfigMap = {
      note: makeField({ field_key: "note", label: "备注", field_type: "TEXT", required: true }),
    };
    expect(moneyValidatorOf(resolveRules(cfg, "note", []))).toBeUndefined();
  });
});

describe("CustomFormField", () => {
  it.each(["custom-to-custom", "core-to-custom", "custom-to-core"])("条件必填可监听%s字段并阻止缺值提交", async (sourceKind) => {
    const source = makeField({ field_key: "source", label: "来源" });
    const note = makeField({ field_key: "details", label: "补充说明", required_when: { field: "source", op: "filled" } });
    const submit = vi.fn();
    const Harness = () => {
      const [form] = Form.useForm();
      return <Form form={form} onFinish={submit}>
        {sourceKind === "core-to-custom" ? <Form.Item name="source" label="来源"><Input /></Form.Item> : <CustomFormField def={source} />}
        {sourceKind === "custom-to-core" ? <CfgItem name="details" label="补充说明" cfg={{ details: note }}><Input /></CfgItem> : <CustomFormField def={note} />}
        <button type="submit">提交</button>
      </Form>;
    };
    renderLight(<Harness />);
    await ui.type(screen.getByLabelText("来源"), "已填写");
    await ui.click(screen.getByRole("button", { name: "提交" }));
    expect(await screen.findByText("补充说明必填")).toBeInTheDocument();
    expect(submit).not.toHaveBeenCalled();
    await ui.type(screen.getByLabelText("补充说明"), "说明");
    await ui.click(screen.getByRole("button", { name: "提交" }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  });

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

  it("DATE 字段提交本地日期字符串而不是 dayjs 对象", async () => {
    const def = makeField({ field_key: "deadline", label: "截止日期", field_type: "DATE" });
    let captured: Record<string, unknown> | null = null;
    const Harness = () => {
      const [form] = Form.useForm();
      return (
        <Form form={form} onFinish={(values) => { captured = values; }}>
          <CustomFormField def={def} />
          <button type="submit">提交日期</button>
        </Form>
      );
    };
    renderLight(<Harness />);
    const input = screen.getByLabelText("截止日期");
    await ui.type(input, "2026-11-16{enter}");
    await ui.click(screen.getByRole("button", { name: "提交日期" }));
    await waitFor(() => expect(captured).not.toBeNull());
    const submitted = captured as unknown as { form_extra: Record<string, unknown> };
    expect(submitted.form_extra.deadline).toBe("2026-11-16");
  });

  it("清空可选自定义字段不会提交 null", async () => {
    const def = makeField({ field_key: "optional_number", label: "可选数字", field_type: "NUMBER" });
    let captured: Record<string, unknown> | null = null;
    const Harness = () => {
      const [form] = Form.useForm();
      return (
        <Form form={form} initialValues={{ form_extra: { optional_number: null } }} onFinish={(values) => { captured = values; }}>
          <CustomFormField def={def} />
          <button type="submit">提交空值</button>
        </Form>
      );
    };
    renderLight(<Harness />);
    await ui.click(screen.getByRole("button", { name: "提交空值" }));
    await waitFor(() => expect(captured).not.toBeNull());
    const cleaned = splitFormExtra(captured ?? {}, { optional_number: def });
    expect(cleaned.orderFormExtra.optional_number).toBeUndefined();
  });

  it("SELECT 字段渲染选项控件", () => {
    const def = makeField({
      field_key: "src",
      label: "来源",
      field_type: "SELECT",
      options: [{ value: "微信", label: "微信" }, { value: "支付宝", label: "支付宝" }],
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

it("运营板块自定义字段显示运营信息分组", () => {
  const def = makeField({ field_key: "consignment_note", label: "寄售运营备注", section: "OPERATION" });
  renderLight(
    <Form>
      <FieldConfigContext.Provider value={{ [def.field_key]: def }}>
        <CustomFieldSection section="OPERATION" testIdSuffix="operation" />
      </FieldConfigContext.Provider>
    </Form>,
  );
  expect(screen.getByText("运营信息")).toBeInTheDocument();
  expect(screen.getByLabelText("寄售运营备注")).toBeInTheDocument();
});

it("多个自定义板块只扫描一次配置，保持分组与字段排序", () => {
  let reads = 0;
  const sections = ["ACCOUNT_PRODUCT", "BUSINESS", "DELIVER", "OPERATION", "FINANCE", "PARTICIPANT", "EXTRA"] as const;
  const fields = sections.flatMap((section, index) => [2, 1].map((sequence) => {
    const field = makeField({ id: index * 2 + sequence, field_key: `field_${index}_${sequence}`, label: `字段${index}-${sequence}`, section, sort_order: sequence });
    return { ...field, get is_custom() { reads += 1; return true; } };
  }));
  const config = Object.fromEntries(fields.map((field) => [field.field_key, field]));
  renderLight(<Form><FieldConfigContext.Provider value={config}><CustomFieldSections excludeSections={["PARTICIPANT"]} testIdSuffix="batch" /></FieldConfigContext.Provider></Form>);
  const first = screen.getByLabelText("字段0-1");
  const second = screen.getByLabelText("字段0-2");
  expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.queryByLabelText("字段5-1")).toBeNull();
  expect(reads).toBeLessThanOrEqual(fields.length * 2);
});

it("独立字段板块共享配置分组，并在原配置对象更新后重新渲染", () => {
  let reads = 0;
  const sections = ["ACCOUNT_PRODUCT", "BUSINESS", "DELIVER", "OPERATION", "FINANCE", "PARTICIPANT", "EXTRA"] as const;
  const fields = sections.map((section, index) => ({
    ...makeField({ id: index + 1, field_key: `field_${index}`, label: `字段${index}`, section }),
    get is_custom() { reads += 1; return true; },
  }));
  const config: FieldConfigMap = Object.fromEntries(fields.map((field) => [field.field_key, field]));
  // 真实配置更新走 setLoaded({ config: map }) 产生新引用；用新对象替换而非原地 mutate，贴合生产数据流。
  const view = (current: FieldConfigMap = config) => <Form><FieldConfigContext.Provider value={current}><CustomFieldSectionsProvider>
    {sections.map((section) => <CustomFieldSection key={section} section={section} />)}
    <CustomFieldSections excludeSections={[...sections]} />
  </CustomFieldSectionsProvider></FieldConfigContext.Provider></Form>;
  const { rerender } = renderLight(view());
  expect(screen.getByLabelText("字段0")).toBeInTheDocument();
  expect(screen.getByLabelText("字段6")).toBeInTheDocument();
  expect(reads).toBeLessThanOrEqual(fields.length * 2);
  rerender(view({ ...config, field_0: { ...config.field_0, label: "更新字段", section: "BUSINESS" } }));
  expect(screen.queryByLabelText("字段0")).toBeNull();
  expect(screen.getByLabelText("更新字段")).toBeInTheDocument();
});

it("内层字段配置覆盖外层分组缓存", () => {
  const outer = makeField({ id: 1, field_key: "outer", label: "外层字段", section: "BUSINESS" });
  const inner = makeField({ id: 2, field_key: "inner", label: "内层字段", section: "BUSINESS" });
  const extra = makeField({ id: 3, field_key: "extra", label: "内层运营字段", section: "OPERATION" });
  renderLight(<Form><FieldConfigContext.Provider value={{ outer }}><CustomFieldSectionsProvider>
    <CustomFieldSection section="BUSINESS" />
    <FieldConfigContext.Provider value={{ inner, extra }}><CustomFieldSection section="BUSINESS" /><CustomFieldSections excludeSections={["BUSINESS"]} /></FieldConfigContext.Provider>
  </CustomFieldSectionsProvider></FieldConfigContext.Provider></Form>);
  expect(screen.getByLabelText("外层字段")).toBeInTheDocument();
  expect(screen.getByLabelText("内层字段")).toBeInTheDocument();
  expect(screen.getByLabelText("内层运营字段")).toBeInTheDocument();
});

it("自定义板块随配置变化更新", () => {
  const field = makeField({ id: 31, field_key: "remark", label: "旧标签", section: "BUSINESS" });
  const { rerender } = renderLight(<Form><FieldConfigContext.Provider value={{ remark: field }}><CustomFieldSections /></FieldConfigContext.Provider></Form>);
  expect(screen.getByLabelText("旧标签")).toBeInTheDocument();
  rerender(<Form><FieldConfigContext.Provider value={{ remark: { ...field, label: "新标签", section: "OPERATION" } }}><CustomFieldSections /></FieldConfigContext.Provider></Form>);
  expect(screen.queryByLabelText("旧标签")).toBeNull();
  expect(screen.getByLabelText("新标签")).toBeInTheDocument();
  expect(screen.getByText("运营信息")).toBeInTheDocument();
});

it("自定义字段配置异步出现时不改变 hooks 顺序", () => {
  const def = makeField({ field_key: "operation_note", label: "运营备注", section: "OPERATION" });
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const { rerender } = renderLight(
    <FieldConfigContext.Provider value={{}}>
      <CustomFieldSection section="OPERATION" testIdSuffix="async" />
    </FieldConfigContext.Provider>,
  );

  rerender(
    <FieldConfigContext.Provider value={{ [def.field_key]: def }}>
      <CustomFieldSection section="OPERATION" testIdSuffix="async" />
    </FieldConfigContext.Provider>,
  );

  expect(screen.getByLabelText("运营备注")).toBeInTheDocument();
  expect(consoleError.mock.calls.flat().join(" ")).not.toContain("change in the order of Hooks");
  consoleError.mockRestore();
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
  it("只接受后端字段契约的对象选项", () => {
    expect(() => resolveOptionItems(["微信"] as never)).toThrow("选项必须使用 value/label 对象");
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

describe("isConditionActive：条件命中判定", () => {
  it("eq：依赖值属于触发值即命中（含多选任一命中）", () => {
    const cond = { field: "customer_source", op: "eq" as const, values: ["其他"] };
    expect(isConditionActive(cond, { customer_source: "其他" })).toBe(true);
    expect(isConditionActive(cond, { customer_source: "微信" })).toBe(false);
    expect(isConditionActive(cond, { customer_source: ["微信", "其他"] })).toBe(true);
  });

  it("ne：依赖值不属于触发值才算命中", () => {
    const cond = { field: "customer_source", op: "ne" as const, values: ["其他"] };
    expect(isConditionActive(cond, { customer_source: "微信" })).toBe(true);
    expect(isConditionActive(cond, { customer_source: "其他" })).toBe(false);
  });

  it("filled：依赖字段有值即命中（空串/空数组/null 不算）", () => {
    const cond = { field: "price", op: "filled" as const };
    expect(isConditionActive(cond, { price: "100" })).toBe(true);
    expect(isConditionActive(cond, { price: "" })).toBe(false);
    expect(isConditionActive(cond, { price: null })).toBe(false);
    expect(isConditionActive(cond, { price: [] })).toBe(false);
    expect(isConditionActive(cond, {})).toBe(false);
  });

  it("无条件时恒为 false", () => {
    expect(isConditionActive(null, { a: "1" })).toBe(false);
    expect(isConditionActive(undefined, { a: "1" })).toBe(false);
  });
});

describe("resolveRules 条件必填：条件命中决定必填", () => {
  const cond = { field: "customer_source", op: "eq" as const, values: ["其他"] };
  const cfg: FieldConfigMap = {
    customer_source_other: makeField({
      field_key: "customer_source_other",
      label: "其他来源",
      required: false,
      required_when: cond,
    }),
  };
  const base = [{ required: true, message: "请输入客户来源" }] as never;

  it("条件命中 → 必填（剥离基础必填后追加配置文案）", () => {
    const out = resolveRules(cfg, "customer_source_other", base, { customer_source: "其他" });
    const requiredRules = out.filter((r) => (r as { required?: boolean }).required);
    expect(requiredRules).toHaveLength(1);
    expect((requiredRules[0] as { message?: string }).message).toBe("其他来源必填");
  });

  it("条件未命中 → 选填（基础必填被剥离）", () => {
    const out = resolveRules(cfg, "customer_source_other", base, { customer_source: "微信" });
    expect(out.filter((r) => (r as { required?: boolean }).required)).toHaveLength(0);
  });

  it("required=true 时忽略条件（必填与条件必填互斥）", () => {
    const forceCfg: FieldConfigMap = {
      customer_source_other: makeField({
        field_key: "customer_source_other",
        label: "其他来源",
        required: true,
        required_when: cond,
      }),
    };
    const out = resolveRules(forceCfg, "customer_source_other", base, { customer_source: "微信" });
    expect(out.filter((r) => (r as { required?: boolean }).required)).toHaveLength(1);
  });
});

describe("CfgItem 条件必填：依赖值变化实时生效", () => {
  const cfg: FieldConfigMap = {
    customer_source: makeField({ field_key: "customer_source", label: "客户来源" }),
    customer_source_other: makeField({
      field_key: "customer_source_other",
      label: "其他来源",
      required: false,
      required_when: { field: "customer_source", op: "eq", values: ["其他"] },
    }),
  };

  const Harness = () => {
    const [form] = Form.useForm();
    return (
      <Form form={form}>
        <CfgItem name="customer_source" label="客户来源">
          <Select
            options={[
              { value: "微信", label: "微信" },
              { value: "其他", label: "其他" },
            ]}
          />
        </CfgItem>
        <CfgItem name="customer_source_other" label="其他来源" rules={[{ required: true, message: "请输入客户来源" }]}>
          <Input aria-label="其他来源输入" />
        </CfgItem>
        <button type="button" onClick={() => form.setFieldsValue({ customer_source: "其他" })}>
          选其他
        </button>
        <button type="button" onClick={() => form.submit()}>
          提交
        </button>
      </Form>
    );
  };

  it("依赖字段变为触发值后，条件字段转为必填并拦截提交", async () => {
    renderLight(
      <FieldConfigContext.Provider value={cfg}>
        <Harness />
      </FieldConfigContext.Provider>,
    );
    // 初始未命中：无必填星号（label 不带 required 标记）
    expect(screen.queryByText("请输入客户来源")).toBeNull();

    await ui.click(screen.getByRole("button", { name: "选其他" }));
    await ui.click(screen.getByRole("button", { name: "提交" }));

    expect(await screen.findByText("其他来源必填")).toBeInTheDocument();
  });
});

describe("fieldLabel / 条件依赖标签 随配置改名更新（引用处同步）", () => {
  it("配置标签变更后 fieldLabel 立即返回新名", () => {
    const cfg: FieldConfigMap = { buyer: makeField({ field_key: "buyer", label: "买家" }) };
    expect(fieldLabel(cfg, "buyer", "买家")).toBe("买家");
    // 设置页改名后前端重新拉取配置（同 field_key、新 label）
    const updated: FieldConfigMap = { buyer: makeField({ field_key: "buyer", label: "购买方" }) };
    expect(fieldLabel(updated, "buyer", "买家")).toBe("购买方");
  });

  it("条件必填的展示依赖标签，随被引用字段改名而更新（复刻面板行188 解析）", () => {
    // 引用方按 field_key 解析被引用方的 label（并非写死原 label）
    const cfg: FieldConfigMap = {
      buyer: makeField({ field_key: "buyer", label: "买家" }),
      buyer_note: makeField({
        field_key: "buyer_note",
        label: "买家备注",
        required_when: { field: "buyer", op: "filled" },
      }),
    };
    const resolveDependentLabel = (c: FieldConfigMap, key: string) => {
      const dep = c[key].required_when;
      return dep ? c[dep.field]?.label : undefined;
    };
    expect(resolveDependentLabel(cfg, "buyer_note")).toBe("买家");
    // 被引用字段改名后，引用处展示新名
    const updated: FieldConfigMap = {
      ...cfg,
      buyer: makeField({ field_key: "buyer", label: "购买方" }),
    };
    expect(resolveDependentLabel(updated, "buyer_note")).toBe("购买方");
  });
});

describe("buildFormExtraDisplay：历史扩展字段值统一展开（含删除/停用兜底）", () => {
  const defs: Array<OrderFormField> = [
    makeField({ field_key: "active_f", label: "活跃字段", is_active: true }),
    makeField({ field_key: "inactive_f", label: "停用字段", is_active: false }),
  ];

  it("有定义：label 取配置名，status 按 is_active 区分 active / inactive", () => {
    const items = buildFormExtraDisplay({ active_f: "甲", inactive_f: "乙" }, defs);
    expect(items).toEqual([
      { key: "active_f", label: "活跃字段", value: "甲", status: "active" },
      { key: "inactive_f", label: "停用字段", value: "乙", status: "inactive" },
    ]);
  });

  it("无定义（字段已删除）：label 回退裸 key，status = deleted", () => {
    const items = buildFormExtraDisplay({ deleted_f: "丙" }, defs);
    expect(items).toEqual([
      { key: "deleted_f", label: "deleted_f", value: "丙", status: "deleted" },
    ]);
  });

  it("过滤空值（null / 空串 / 空数组）；extra 为 null / undefined 返回 []", () => {
    const items = buildFormExtraDisplay(
      { empty1: null, empty2: "", empty3: [], keep: "x" },
      defs,
    );
    expect(items).toEqual([
      { key: "keep", label: "keep", value: "x", status: "deleted" },
    ]);
    expect(buildFormExtraDisplay(undefined, defs)).toEqual([]);
    expect(buildFormExtraDisplay(null, defs)).toEqual([]);
  });
});

describe("sectionLabel / SectionLabelsContext：板块标题跟随后端配置", () => {
  function TitleProbe(props: { sectionKey: string; fallback: string }) {
    return <span data-testid="title">{sectionLabel(props.sectionKey, props.fallback)}</span>;
  }

  it("无覆盖时回退硬编码 fallback", () => {
    renderLight(<TitleProbe sectionKey="FINANCE" fallback="资金明细" />);
    expect(screen.getByTestId("title")).toHaveTextContent("资金明细");
  });

  it("设置面板改板块名后，建单通过 SectionLabelsContext 同步显示新名", () => {
    // 复刻 CreateBusinessModal：把后端返回的覆盖映射注入 SectionLabelsContext
    renderLight(
      <SectionLabelsContext.Provider value={{ FINANCE: "资金明细改名" }}>
        <TitleProbe sectionKey="FINANCE" fallback="资金明细" />
      </SectionLabelsContext.Provider>,
    );
    expect(screen.getByTestId("title")).toHaveTextContent("资金明细改名");
  });

  it("未覆盖的板块仍显示 fallback，已覆盖的显示新名（混合场景）", () => {
    renderLight(
      <SectionLabelsContext.Provider value={{ PARTICIPANT: "供货方信息改名" }}>
        <TitleProbe sectionKey="PARTICIPANT" fallback="供货方信息" />
        <TitleProbe sectionKey="FINANCE" fallback="资金明细" />
      </SectionLabelsContext.Provider>,
    );
    const probes = screen.getAllByTestId("title");
    expect(probes[0]).toHaveTextContent("供货方信息改名");
    expect(probes[1]).toHaveTextContent("资金明细");
  });
});
