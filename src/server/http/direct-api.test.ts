import { describe, expect, it, vi } from "vitest";
import { handleDirectApiRequest } from "./direct-api";

vi.mock("./health-handler", () => ({
  handleHealthRequest: async () => Response.json({ status: "ok" }),
}));

describe("direct API dispatch", () => {
  it("handles the health endpoint without entering the application router", async () => {
    const response = await handleDirectApiRequest(new Request("https://lfio.test/api/health"));

    expect(response).toBeInstanceOf(Response);
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({ status: "ok" });
  });

  it("leaves page requests and unsupported API methods to TanStack Start", () => {
    expect(handleDirectApiRequest(new Request("https://lfio.test/dashboard"))).toBeNull();
    expect(
      handleDirectApiRequest(new Request("https://lfio.test/api/mcp", { method: "GET" })),
    ).toBeNull();
  });
});
