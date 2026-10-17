import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoginPage } from "./LoginPage";

const mocks = vi.hoisted(() => ({
  checkBackendHealth: vi.fn(),
  login: vi.fn(),
}));

vi.mock("../shared/api/client", () => ({
  checkBackendHealth: mocks.checkBackendHealth,
  errorMessage: (error: unknown) => String(error),
}));

vi.mock("../shared/state/session", () => ({
  useSession: () => ({ login: mocks.login }),
}));

describe("LoginPage：后端前置检查", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("后端不可达时显示连接提示，而不是等待登录后才报 500", async () => {
    mocks.checkBackendHealth.mockRejectedValueOnce(new Error("后端不可达"));

    render(<LoginPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent("后端不可达");
  });
});
