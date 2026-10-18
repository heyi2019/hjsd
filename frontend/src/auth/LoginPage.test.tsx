import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { LoginPage } from "./LoginPage";

import * as client from "../shared/api/client";
vi.mock("../shared/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../shared/api/client")>()),
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  login: vi.fn(),
  logout: vi.fn(),
  setDevUser: vi.fn(),
  changePassword: vi.fn(),
  checkBackendHealth: vi.fn(),
}));

describe("LoginPage：后端前置检查", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("后端不可达时显示连接提示，而不是等待登录后才报 500", async () => {
    vi.mocked(client.checkBackendHealth).mockRejectedValueOnce(new Error("后端不可达"));

    renderLight(<LoginPage />, { user: "admin" });

    expect(await screen.findByRole("alert")).toHaveTextContent("后端不可达");
  });
});
