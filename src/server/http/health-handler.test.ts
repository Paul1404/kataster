import { describe, expect, it } from "vitest";
import { createHealthHandler } from "./health-handler";

describe("readiness", () => {
  it("accepts requests only after dependencies answer", async () => {
    let checked = false;
    const response = await createHealthHandler(async () => {
      checked = true;
    })();
    expect(checked).toBe(true);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  it("rejects readiness without leaking connection details", async () => {
    const response = await createHealthHandler(async () => {
      throw new Error("private database URL");
    })();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unavailable" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
