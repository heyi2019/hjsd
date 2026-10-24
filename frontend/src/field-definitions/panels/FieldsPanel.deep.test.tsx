import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { message } from "antd";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as catalog from "../../shared/api/catalog";
import { renderLight } from "../../test/render";
import { FieldsPanel } from "./FieldsPanel";
import type { FieldDefinition } from "../../shared/api/catalog";

vi.mock("../../shared/api/catalog");

const activeRow: FieldDefinition = {
  id: 1,
  entity_type: "customer",
  field_key: "credit_level",
  label: "信用等级",
  field_type: "TEXT",
  options: null,
  required: false,
  is_active: true,
  sort_order: 1,
};

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.clearAllMocks();
  vi.mocked(catalog.fieldsApi).list.mockResolvedValue([activeRow]);
  vi.mocked(catalog.fieldsApi).create.mockResolvedValue({ id: 99 } as never);
  vi.mocked(catalog.fieldsApi).update.mockResolvedValue(undefined as never);
  vi.mocked(catalog.fieldsApi).setActive.mockResolvedValue(undefined as never);
  vi.mocked(catalog.fieldsApi).remove.mockResolvedValue(undefined as never);
  vi.spyOn(message, "success").mockImplementation((() => undefined) as never);
  vi.spyOn(message, "error").mockImplementation((() => undefined) as never);
});

async function pickFormSelect(labelText: string, optionText: string) {
  const sel = screen.getByLabelText(labelText).closest(".ant-select") as HTMLElement;
  await ui.click(sel.querySelector(".ant-select-selector") as HTMLElement);
  await ui.click(await screen.findByText(optionText, { selector: ".ant-select-item-option-content" }));
}

async function rowOf(label: string): Promise<HTMLElement> {
  return (await screen.findByText(label)).closest("tr") as HTMLElement;
}

describe("FieldsPanel.deep", () => {
  it("加载失败展示错误横幅，点重新加载再次请求", async () => {
    vi.mocked(catalog.fieldsApi).list.mockRejectedValueOnce(new Error("load fail"));
    renderLight(<FieldsPanel />, { user: "admin" });
    await screen.findByText(/load fail/);
    expect(catalog.fieldsApi.list).toHaveBeenCalledTimes(1);
    await ui.click(screen.getByRole("button", { name: /重新加载/ }));
    await waitFor(() => expect(catalog.fieldsApi.list).toHaveBeenCalledTimes(2));
  });

  it("渲染覆盖：未知类型/选项/必填/启用 各分支", async () => {
    vi.mocked(catalog.fieldsApi).list.mockResolvedValue([
      { id: 1, entity_type: "UNKNOWN", field_key: "x", label: "X", field_type: "WAT", is_active: true, options: ["a", "b"], required: true, sort_order: 1 },
      { id: 2, entity_type: "customer", field_key: "y", label: "Y", field_type: "TEXT", is_active: false, options: null, required: false, sort_order: 2 },
    ]);
    renderLight(<FieldsPanel />, { user: "admin" });
    expect(await screen.findByText("UNKNOWN")).toBeInTheDocument();
    expect(screen.getByText("WAT")).toBeInTheDocument();
    expect(screen.getByText("a、b")).toBeInTheDocument();
    expect(screen.getAllByText("-").length).toBeGreaterThan(0);
    expect(screen.getAllByText("是").length).toBeGreaterThan(0);
    expect(screen.getAllByText("否").length).toBeGreaterThan(0);
  });

  it("新增字段成功走 create 并提示", async () => {
    renderLight(<FieldsPanel />, { user: "admin" });
    await screen.findByText("信用等级");
    await ui.type(screen.getByLabelText("字段键"), "credit_score");
    await ui.type(screen.getByLabelText("标签"), "信用分");
    await ui.click(screen.getByRole("button", { name: /新增字段/ }));
    await waitFor(() => expect(catalog.fieldsApi.create).toHaveBeenCalled());
    const payload = vi.mocked(catalog.fieldsApi).create.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      entity_type: "customer",
      field_type: "TEXT",
      field_key: "credit_score",
      label: "信用分",
      required: false,
      sort_order: 0,
      options: undefined,
    });
    expect(message.success).toHaveBeenCalledWith("活字段已创建");
  });

  it("新增单选类型字段会解析逗号分隔选项", async () => {
    renderLight(<FieldsPanel />, { user: "admin" });
    await screen.findByText("信用等级");
    await pickFormSelect("类型", "单选");
    const optInput = await screen.findByLabelText("选项");
    await ui.type(optInput, "优质,观察");
    await ui.type(screen.getByLabelText("字段键"), "level");
    await ui.type(screen.getByLabelText("标签"), "等级");
    await ui.click(screen.getByRole("button", { name: /新增字段/ }));
    await waitFor(() => expect(catalog.fieldsApi.create).toHaveBeenCalled());
    const payload = vi.mocked(catalog.fieldsApi).create.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.field_type).toBe("SELECT");
    expect(payload.options).toEqual(["优质", "观察"]);
  });

  it("新增单选类型但选项为空时 options 落空数组", async () => {
    renderLight(<FieldsPanel />, { user: "admin" });
    await screen.findByText("信用等级");
    await pickFormSelect("类型", "单选");
    await ui.type(screen.getByLabelText("字段键"), "lv");
    await ui.type(screen.getByLabelText("标签"), "等级");
    await ui.click(screen.getByRole("button", { name: /新增字段/ }));
    await waitFor(() => expect(catalog.fieldsApi.create).toHaveBeenCalled());
    const payload = vi.mocked(catalog.fieldsApi).create.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.options).toEqual([]);
  });

  it("点编辑回填表单，保存走 update 并提示", async () => {
    renderLight(<FieldsPanel />, { user: "admin" });
    const row = await rowOf("信用等级");
    await ui.click(within(row).getByRole("button", { name: /编辑/ }));
    const labelInput = screen.getByLabelText("标签");
    await ui.clear(labelInput);
    await ui.type(labelInput, "信用等级(改)");
    await ui.click(screen.getByRole("button", { name: /保存字段/ }));
    await waitFor(() => expect(catalog.fieldsApi.update).toHaveBeenCalled());
    expect(catalog.fieldsApi.update).toHaveBeenCalledWith(1, expect.objectContaining({ label: "信用等级(改)" }));
    expect(message.success).toHaveBeenCalledWith("活字段已更新");
  });

  it("编辑中点取消编辑重置表单回到新增态", async () => {
    renderLight(<FieldsPanel />, { user: "admin" });
    const row = await rowOf("信用等级");
    await ui.click(within(row).getByRole("button", { name: /编辑/ }));
    expect(screen.getByRole("button", { name: /保存字段/ })).toBeInTheDocument();
    await ui.click(screen.getByRole("button", { name: /取消编辑/ }));
    expect(screen.getByRole("button", { name: /新增字段/ })).toBeInTheDocument();
  });

  it("停用字段走 setActive(id,false) 并重载", async () => {
    renderLight(<FieldsPanel />, { user: "admin" });
    const row = await rowOf("信用等级");
    await ui.click(within(row).getByRole("button", { name: /停用/ }));
    await screen.findByText("停用字段「信用等级」");
    await ui.click(screen.getByRole("button", { name: /确认/ }));
    await waitFor(() => expect(catalog.fieldsApi.setActive).toHaveBeenCalledWith(1, false));
  });

  it("启用字段走 setActive(id,true) 并重载", async () => {
    vi.mocked(catalog.fieldsApi).list.mockResolvedValue([{ ...activeRow, id: 2, label: "备注", is_active: false }]);
    renderLight(<FieldsPanel />, { user: "admin" });
    const row = await rowOf("备注");
    await ui.click(within(row).getByRole("button", { name: /启用/ }));
    await screen.findByText("启用字段「备注」");
    await ui.click(screen.getByRole("button", { name: /确认/ }));
    await waitFor(() => expect(catalog.fieldsApi.setActive).toHaveBeenCalledWith(2, true));
  });

  it("删除字段成功走 remove 并提示", async () => {
    renderLight(<FieldsPanel />, { user: "admin" });
    const row = await rowOf("信用等级");
    await ui.click(within(row).getByRole("button", { name: /删除/ }));
    await screen.findByText("删除字段「信用等级」");
    await ui.click(screen.getByRole("button", { name: /OK/ }));
    await waitFor(() => expect(catalog.fieldsApi.remove).toHaveBeenCalledWith(1));
    expect(message.success).toHaveBeenCalledWith("字段已删除");
  });

  it("删除失败展示错误横幅", async () => {
    vi.mocked(catalog.fieldsApi).remove.mockRejectedValue(new Error("has history"));
    renderLight(<FieldsPanel />, { user: "admin" });
    const row = await rowOf("信用等级");
    await ui.click(within(row).getByRole("button", { name: /删除/ }));
    await screen.findByText("删除字段「信用等级」");
    await ui.click(screen.getByRole("button", { name: /OK/ }));
    await screen.findByText(/has history/);
  });

  it("新增字段失败展示错误横幅", async () => {
    vi.mocked(catalog.fieldsApi).create.mockRejectedValue(new Error("db error"));
    renderLight(<FieldsPanel />, { user: "admin" });
    await screen.findByText("信用等级");
    await ui.type(screen.getByLabelText("字段键"), "k");
    await ui.type(screen.getByLabelText("标签"), "K");
    await ui.click(screen.getByRole("button", { name: /新增字段/ }));
    await screen.findByText(/db error/);
  });

  it("更新字段失败展示错误横幅", async () => {
    vi.mocked(catalog.fieldsApi).update.mockRejectedValue(new Error("update fail"));
    renderLight(<FieldsPanel />, { user: "admin" });
    const row = await rowOf("信用等级");
    await ui.click(within(row).getByRole("button", { name: /编辑/ }));
    await ui.click(screen.getByRole("button", { name: /保存字段/ }));
    await screen.findByText(/update fail/);
  });
});
