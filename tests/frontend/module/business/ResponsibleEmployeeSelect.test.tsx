import { Form } from "antd";
import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";

// 会话里 role 与 username 是两个不同的值：role 是系统角色（operator），
// username 才是 users 表里的人（xiaoxuan）。这正是生产环境的形态，
// 也是「拿角色去比用户名」这个缺陷在 dev 态（两者同为 "admin"）看不出来的原因。
const session = { role: "operator", username: "xiaoxuan" };
vi.mock("@/shared/state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/state/session")>()),
  useSession: () => session,
}));
vi.mock("@/shared/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/api/client")>()),
  currentUser: vi.fn(),
}));

import * as client from "@/shared/api/client";
import { ResponsibleEmployeeSelect } from "@/orders/ResponsibleEmployeeSelect";

const employees = [
  { id: 3, username: "operator", display_name: "业务员", is_active: true },
  { id: 5, username: "xiaoxuan", display_name: "小轩", is_active: true },
];

function Harness() {
  const [form] = Form.useForm();
  return (
    <Form form={form} initialValues={{ owners: undefined }}>
      <ResponsibleEmployeeSelect name="owners" label="交付操作人" employees={employees} />
    </Form>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // 让 /auth/me 这条兜底路径失效：本用例只验证「按 username 匹配」这一条，
  // 若它挂了，默认值必须由 username 命中，而不是被异步接口掩盖。
  vi.mocked(client.currentUser).mockRejectedValue(new Error("no session"));
});

describe("ResponsibleEmployeeSelect：按人匹配用 username，不用角色", () => {
  it("默认勾选与当前用户名一致的员工，而不是同名的角色", async () => {
    renderLight(<Harness />);
    const select = screen.getByLabelText("交付操作人");
    await waitFor(() => {
      // 命中 users.username === "xiaoxuan" 的小轩
      expect(select.closest(".ant-select")?.textContent).toContain("小轩");
    });
    // 不能因为 role === "operator" 就钩上 username 恰好同名的「业务员」
    expect(select.closest(".ant-select")?.textContent).not.toContain("业务员");
  });
});
