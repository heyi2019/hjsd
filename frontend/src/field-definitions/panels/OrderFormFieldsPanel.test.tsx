/** OrderFormFieldsPanel 交互测试：挂载拉取、新增、行内必填开关、停用、删除、预置字段禁用。 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appMessage as message } from "../../shared/ui/appFeedback";
import * as catalog from "../../shared/api/catalog";
vi.mock("../../shared/api/catalog");
import * as client from "../../shared/api/client";
import { renderLight } from "../../test/render";
import { OrderFormFieldsPanel } from "./OrderFormFieldsPanel";

vi.mock("../../shared/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/api/client")>()),
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
  login: vi.fn(),
  logout: vi.fn(),
  setDevUser: vi.fn(),
  changePassword: vi.fn(),
  checkBackendHealth: vi.fn(),
}));

type Field = catalog.OrderFormField;

const makeField = (over: Partial<Field> = {}): Field => ({
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
  localStorage.clear();
  vi.clearAllMocks();
  vi.spyOn(message, "success").mockImplementation(() => ({}) as never);
  vi.spyOn(message, "error").mockImplementation(() => ({}) as never);
  vi.mocked(catalog.orderFormFieldsApi).list.mockResolvedValue([]);
  vi.mocked(catalog.orderFormFieldsApi).scopes = vi.fn().mockResolvedValue([]);
  vi.mocked(catalog.gameTypesApi.list).mockResolvedValue([]);
  vi.mocked(catalog.optionSetsApi).get = vi.fn().mockResolvedValue({ options: [] } as never);
});

describe("OrderFormFieldsPanel", () => {
  it("显示板块管理容器并列出运营信息板块", async () => {
    renderLight(<OrderFormFieldsPanel />, { user: "admin" });

    expect(await screen.findByText("板块管理")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "板块键" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "板块名称" })).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader", { name: "排序" }).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByRole("columnheader", { name: "操作" }).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("运营信息")).toBeInTheDocument();
    expect(screen.getByText("账号 / 产品信息")).toBeInTheDocument();
    expect(screen.getByText("交付信息")).toBeInTheDocument();
    expect(screen.queryByText(/选择上方「表单」可配置任意业务表单的字段/)).toBeNull();
    expect(screen.queryByText(/可调整板块在本页的展示顺序/)).toBeNull();
    const createContainer = screen.getByText("新增自定义字段").closest(".order-form-fields__create-container");
    const managementCard = screen.getByText("板块管理").closest(".ant-card");
    expect(createContainer && managementCard && (createContainer.compareDocumentPosition(managementCard) & Node.DOCUMENT_POSITION_FOLLOWING)).toBeTruthy();
    const managementTable = screen.getByTestId("form-section-management");
    const addSectionButton = within(managementCard as HTMLElement).getByText("新增板块") as HTMLElement;
    expect(managementTable.compareDocumentPosition(addSectionButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("板块管理不再提供上下移动（顺序由字段所属板块驱动）", async () => {
    renderLight(<OrderFormFieldsPanel />, { user: "admin" });
    await screen.findByText("板块管理");

    // 板块顺序现在由字段所属板块（section）驱动，设置面板不再提供误导性的上下移动按钮
    expect(screen.queryByRole("button", { name: "运营信息上移" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "运营信息下移" })).not.toBeInTheDocument();
    // 编辑 / 查看字段 入口保留
    expect(screen.getByRole("button", { name: "编辑运营信息" })).toBeInTheDocument();
    expect(screen.getAllByText("查看字段").length).toBeGreaterThan(0);
  });

  it("板块管理显示编码并可编辑板块名称", async () => {
    renderLight(<OrderFormFieldsPanel />, { user: "admin" });
    await screen.findByText("板块管理");

    expect(screen.getByText("OPERATION")).toBeInTheDocument();
    await ui.click(screen.getByRole("button", { name: "编辑运营信息" }));
    expect(await screen.findByDisplayValue("运营信息")).toHaveValue("运营信息");
  });

  it("板块管理可以编辑板块键", async () => {
    renderLight(<OrderFormFieldsPanel />, { user: "admin" });
    await screen.findByText("板块管理");

    await ui.click(screen.getByRole("button", { name: "编辑运营信息" }));
    expect(await screen.findByDisplayValue("OPERATION")).toHaveValue("OPERATION");
  });

  it("板块管理可以新增板块", async () => {
    localStorage.setItem("heijin.form-field-section-order", JSON.stringify([
      "ACCOUNT_PRODUCT", "BUSINESS", "DELIVER", "OPERATION", "FINANCE", "EXTRA", "PARTICIPANT", "CUSTOM_OPS",
    ]));
    localStorage.setItem("heijin.form-field-section-labels", JSON.stringify({ CUSTOM_OPS: "自定义运营" }));
    renderLight(<OrderFormFieldsPanel />, { user: "admin" });
    await screen.findByText("板块管理");

    expect(screen.getByText("CUSTOM_OPS")).toBeInTheDocument();
    expect(screen.getByText("自定义运营")).toBeInTheDocument();
  });

  it("挂载时按当前业务类型拉取字段列表", async () => {
    vi.mocked(catalog.orderFormFieldsApi).list.mockResolvedValue([
      makeField({ id: 10, field_key: "tag", label: "自定义标签A", locked: false, is_custom: true }),
    ]);
    renderLight(<OrderFormFieldsPanel />, { user: "admin" });
    expect(await screen.findByText("自定义标签A")).toBeInTheDocument();
    expect(vi.mocked(catalog.orderFormFieldsApi).list).toHaveBeenCalledWith("HS", true);
  });

  it("新增自定义字段调用 create 并刷新列表", async () => {
    vi.mocked(catalog.orderFormFieldsApi).list.mockResolvedValue([]);
    renderLight(<OrderFormFieldsPanel />, { user: "admin" });
    await screen.findByText("该表单暂无字段配置");

    await ui.type(screen.getByLabelText("字段键"), "vip_tag");
    await ui.type(screen.getByLabelText("标签"), "VIP标签");
    await ui.click(screen.getByRole("button", { name: /新增字段/ }));

    await waitFor(() =>
      expect(vi.mocked(catalog.orderFormFieldsApi).create).toHaveBeenCalled(),
    );
    const payload = vi.mocked(catalog.orderFormFieldsApi).create.mock.calls[0][0] as Partial<Field>;
    expect(payload.field_key).toBe("vip_tag");
    expect(payload.label).toBe("VIP标签");
    expect(payload.order_type_code).toBe("HS");
  });

  it("停用字段调用 setActive(false)", async () => {
    vi.mocked(catalog.orderFormFieldsApi).list.mockResolvedValue([
      makeField({ id: 20, field_key: "tag", label: "可停用字段", locked: false, is_custom: true, is_active: true }),
    ]);
    renderLight(<OrderFormFieldsPanel />, { user: "admin" });
    await screen.findByText("可停用字段");

    await ui.click(screen.getByText("停用"));
    await ui.click(await screen.findByRole("button", { name: /确认/ }));

    await waitFor(() =>
      expect(vi.mocked(catalog.orderFormFieldsApi).setActive).toHaveBeenCalledWith(20, false),
    );
  });

  it("预置字段（非自定义）删除按钮禁用", async () => {
    vi.mocked(catalog.orderFormFieldsApi).list.mockResolvedValue([
      makeField({ id: 30, field_key: "core", label: "预置字段X", locked: true, is_custom: false }),
    ]);
    renderLight(<OrderFormFieldsPanel />, { user: "admin" });
    await screen.findByText("预置字段X");
    expect(screen.getByRole("button", { name: /删除/ })).toBeDisabled();
  });

  it("游戏类型字段显示数据源并可进入游戏类型配置", async () => {
    const onConfigureGameTypes = vi.fn();
    vi.mocked(catalog.orderFormFieldsApi).list.mockResolvedValue([
      makeField({ field_key: "game_type", label: "游戏类型", field_type: "SELECT", locked: true, is_custom: false }),
    ]);
    vi.mocked(catalog.gameTypesApi.list).mockResolvedValue([
      { id: 1, name: "王者荣耀", sort_order: 1, is_active: true, is_default: false },
      { id: 2, name: "原神", sort_order: 2, is_active: true, is_default: false },
    ]);
    renderLight(<OrderFormFieldsPanel onConfigureGameTypes={onConfigureGameTypes} />, { user: "admin" });
    expect(await screen.findByText("游戏类型主数据 · 王者荣耀、原神等 2 项")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /配置游戏类型/ })).toBeNull();
    await ui.click(screen.getByRole("button", { name: "编辑游戏类型" }));
    await ui.click(screen.getByRole("button", { name: /配置游戏类型/ }));
    expect(onConfigureGameTypes).toHaveBeenCalledOnce();
  });

  it("编辑字段时将编辑区展开在该字段行的下方", async () => {
    vi.mocked(catalog.orderFormFieldsApi).list.mockResolvedValue([
      makeField({ id: 61, field_key: "tag", label: "行内编辑字段", is_custom: true }),
    ]);
    renderLight(<OrderFormFieldsPanel />, { user: "admin" });
    await screen.findByText("行内编辑字段");

    await ui.click(screen.getByRole("button", { name: "编辑行内编辑字段" }));

    expect(screen.getByLabelText("标签").closest(".ant-table-expanded-row")).not.toBeNull();
  });

  it("编辑区修改标签、归属板块、必填和排序后可成功保存", async () => {
    vi.mocked(catalog.orderFormFieldsApi).list.mockResolvedValue([
      makeField({ id: 62, field_key: "tag", label: "编辑前标签", is_custom: true }),
    ]);
    renderLight(<OrderFormFieldsPanel />, { user: "admin" });
    await screen.findByText("编辑前标签");

    await ui.click(screen.getByRole("button", { name: "编辑编辑前标签" }));
    const labelInput = screen.getByLabelText("标签");
    await ui.clear(labelInput);
    await ui.type(labelInput, "编辑后标签");
    await ui.click(screen.getByRole("combobox", { name: "归属板块" }));
    const businessOption = (await screen.findAllByText("业务方案信息")).find((element) => element.classList.contains("ant-select-item-option-content"));
    expect(businessOption).toBeDefined();
    await ui.click(businessOption!);
    await ui.click(screen.getByLabelText("必填"));
    const sortInput = screen.getByLabelText("排序");
    await ui.clear(sortInput);
    await ui.type(sortInput, "20");
    await ui.click(screen.getByRole("button", { name: /保存字段/ }));

    await waitFor(() => expect(vi.mocked(catalog.orderFormFieldsApi).update).toHaveBeenCalledWith(
      62,
      expect.objectContaining({
        label: "编辑后标签",
        required: true,
        section: "BUSINESS",
        sort_order: 20,
      }),
    ));
    expect(vi.mocked(catalog.orderFormFieldsApi).list).toHaveBeenCalledTimes(2);
  });

  it("归属板块支持运营信息", async () => {
    vi.mocked(catalog.orderFormFieldsApi).list.mockResolvedValue([
      makeField({ id: 63, field_key: "operation_note", label: "运营备注" }),
    ]);
    renderLight(<OrderFormFieldsPanel />, { user: "admin" });
    await screen.findByText("运营备注");

    await ui.click(screen.getByRole("button", { name: "编辑运营备注" }));
    await ui.click(screen.getByRole("combobox", { name: "归属板块" }));
    const operationOption = (await screen.findAllByText("运营信息")).find((element) => element.classList.contains("ant-select-item-option-content"));
    expect(operationOption).toBeDefined();
    await ui.click(operationOption!);
    await ui.click(screen.getByRole("button", { name: /保存字段/ }));

    await waitFor(() => expect(vi.mocked(catalog.orderFormFieldsApi.update)).toHaveBeenCalledWith(
      63,
      expect.objectContaining({ section: "OPERATION" }),
    ));
  });

  it.each(["TEXT", "NUMBER", "DATE", "BOOLEAN", "SELECT", "MULTI_SELECT"] as const)(
    "逐一验证 %s 类型字段进入编辑态后可保存",
    async (fieldType) => {
      const field = makeField({
        id: 100 + ["TEXT", "NUMBER", "DATE", "BOOLEAN", "SELECT", "MULTI_SELECT"].indexOf(fieldType),
        field_key: `${fieldType.toLowerCase()}_field`,
        label: `${fieldType}编辑前`,
        field_type: fieldType,
        options: fieldType === "SELECT" || fieldType === "MULTI_SELECT"
          ? [{ value: "A", label: "A" }, { value: "B", label: "B" }]
          : null,
      });
      vi.mocked(catalog.orderFormFieldsApi).list.mockResolvedValue([field]);
      renderLight(<OrderFormFieldsPanel />, { user: "admin" });
      await screen.findByText(`${fieldType}编辑前`);

      await ui.click(screen.getByRole("button", { name: `编辑${field.label}` }));
      const labelInput = screen.getByLabelText("标签");
      await ui.clear(labelInput);
      await ui.type(labelInput, `${fieldType}编辑后`);
      await ui.click(screen.getByRole("button", { name: /保存字段/ }));

      await waitFor(() => expect(vi.mocked(catalog.orderFormFieldsApi).update).toHaveBeenCalledWith(
        field.id,
        expect.objectContaining({ label: `${fieldType}编辑后` }),
      ));
      const payload = vi.mocked(catalog.orderFormFieldsApi).update.mock.calls[0][1] as Partial<Field>;
      if (fieldType === "SELECT" || fieldType === "MULTI_SELECT") {
        expect(payload.options).toEqual([
          { value: "A", label: "A" },
          { value: "B", label: "B" },
        ]);
      } else {
        expect(payload.options).toBeUndefined();
      }
    },
  );

  it("行内必填开关切换调用 update 并刷新", async () => {
    vi.mocked(catalog.orderFormFieldsApi).list.mockResolvedValue([
      makeField({ id: 50, field_key: "vip", label: "VIP字段", required: false, is_custom: true }),
    ]);
    renderLight(<OrderFormFieldsPanel />, { user: "admin" });
    await screen.findByText("VIP字段");

    const toggle = screen.getByLabelText("必填_vip");
    expect(toggle).not.toBeChecked();
    await ui.click(toggle);

    await waitFor(() =>
      expect(vi.mocked(catalog.orderFormFieldsApi).update).toHaveBeenCalledWith(50, { required: true }),
    );
    expect(vi.mocked(catalog.orderFormFieldsApi).list).toHaveBeenCalledTimes(2);
  });

  it("已必填字段再次点击行内开关改为选填", async () => {
    vi.mocked(catalog.orderFormFieldsApi).list.mockResolvedValue([
      makeField({ id: 51, field_key: "note", label: "备注字段", required: true, is_custom: true }),
    ]);
    renderLight(<OrderFormFieldsPanel />, { user: "admin" });
    await screen.findByText("备注字段");

    const toggle = screen.getByLabelText("必填_note");
    expect(toggle).toBeChecked();
    await ui.click(toggle);

    await waitFor(() =>
      expect(vi.mocked(catalog.orderFormFieldsApi).update).toHaveBeenCalledWith(51, { required: false }),
    );
  });

  it("删除自定义字段调用 remove", async () => {
    vi.mocked(catalog.orderFormFieldsApi).list.mockResolvedValue([
      makeField({ id: 40, field_key: "c1", label: "自定义字段Z", locked: false, is_custom: true }),
    ]);
    renderLight(<OrderFormFieldsPanel />, { user: "admin" });
    await screen.findByText("自定义字段Z");

    await ui.click(screen.getByText("删除"));
    await ui.click(await screen.findByRole("button", { name: /OK/ }));

    await waitFor(() =>
      expect(vi.mocked(catalog.orderFormFieldsApi).remove).toHaveBeenCalledWith(40),
    );
  });
});

describe("OrderFormFieldsPanel 条件必填", () => {
  it("列表展示条件必填描述", async () => {
    vi.mocked(catalog.orderFormFieldsApi).list.mockResolvedValue([
      makeField({ id: 70, field_key: "customer_source", label: "客户来源", field_type: "SELECT", options: [{ value: "其他", label: "其他" }, { value: "微信", label: "微信" }] }),
      makeField({
        id: 71,
        field_key: "customer_source_other",
        label: "其他来源",
        required: false,
        required_when: { field: "customer_source", op: "eq", values: ["其他"] },
      }),
    ]);
    renderLight(<OrderFormFieldsPanel />, { user: "admin" });
    await screen.findByText("其他来源");
    expect(screen.getByLabelText("条件_customer_source_other")).toHaveTextContent(
      "条件必填：客户来源 等于 其他",
    );
  });

  it("保存条件必填时提交 required_when 并把 required 置为 false", async () => {
    vi.mocked(catalog.orderFormFieldsApi).list.mockResolvedValue([
      makeField({ id: 80, field_key: "customer_source", label: "客户来源", field_type: "SELECT", options: [{ value: "其他", label: "其他" }, { value: "微信", label: "微信" }] }),
      makeField({ id: 81, field_key: "other_source", label: "其他来源", required: true }),
    ]);
    renderLight(<OrderFormFieldsPanel />, { user: "admin" });
    await screen.findByText("其他来源");

    await ui.click(screen.getByRole("button", { name: "编辑其他来源" }));
    // 选择依赖字段「客户来源（customer_source）」
    const depSelect = screen.getByLabelText("条件必填·依赖字段");
    await ui.click(depSelect);
    await ui.click(await screen.findByTitle("客户来源（customer_source）"));

    await ui.click(screen.getByRole("button", { name: /保存字段/ }));

    await waitFor(() => expect(vi.mocked(catalog.orderFormFieldsApi).update).toHaveBeenCalled());
    const [id, payload] = vi.mocked(catalog.orderFormFieldsApi).update.mock.calls[0];
    expect(id).toBe(81);
    expect(payload.required).toBe(false);
    expect(payload.required_when).toMatchObject({ field: "customer_source", op: "eq" });
  });
});

describe("OrderFormFieldsPanel 依赖防护", () => {
  it("停用被条件引用的字段失败时即时提示原因，不重载列表", async () => {
    vi.mocked(catalog.orderFormFieldsApi).list.mockResolvedValue([
      makeField({ id: 90, field_key: "src", label: "来源字段", is_active: true, locked: false, is_custom: true }),
    ]);
    vi.mocked(catalog.orderFormFieldsApi).setActive.mockRejectedValue(
      new Error("字段「来源字段」被 1 个条件必填引用（「其他来源」），无法停用；请先解除这些字段的条件必填"),
    );
    renderLight(<OrderFormFieldsPanel />, { user: "admin" });
    await screen.findByText("来源字段");
    const listCalls = vi.mocked(catalog.orderFormFieldsApi).list.mock.calls.length;

    await ui.click(screen.getByText("停用"));
    await ui.click(await screen.findByRole("button", { name: /确认/ }));

    await waitFor(() =>
      expect(message.error).toHaveBeenCalledWith(expect.stringContaining("请先解除")),
    );
    // 操作失败不触发重新拉取
    expect(vi.mocked(catalog.orderFormFieldsApi).list.mock.calls.length).toBe(listCalls);
  });

  it("删除被条件引用的字段失败时即时提示原因", async () => {
    vi.mocked(catalog.orderFormFieldsApi).list.mockResolvedValue([
      makeField({ id: 91, field_key: "src2", label: "来源字段2", locked: false, is_custom: true }),
    ]);
    vi.mocked(catalog.orderFormFieldsApi).remove.mockRejectedValue(
      new Error("字段「来源字段2」被 1 个条件必填引用（「其他来源2」），无法删除；请先解除这些字段的条件必填"),
    );
    renderLight(<OrderFormFieldsPanel />, { user: "admin" });
    await screen.findByText("来源字段2");

    await ui.click(screen.getByText("删除"));
    await ui.click(await screen.findByRole("button", { name: /OK/ }));

    await waitFor(() =>
      expect(message.error).toHaveBeenCalledWith(expect.stringContaining("无法删除")),
    );
    expect(vi.mocked(catalog.orderFormFieldsApi).remove).toHaveBeenCalledWith(91);
  });
});
