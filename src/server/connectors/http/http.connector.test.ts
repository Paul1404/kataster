import * as v from "valibot";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CheckContext } from "../types";
import { httpConnector } from "./http.connector";

const ctx: CheckContext = { signal: new AbortController().signal, now: new Date() };

function config(overrides: Record<string, unknown> = {}) {
  return v.parse(httpConnector.configSchema, overrides) as any;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("httpConnector.check", () => {
  it("reports up for a matching status code with low latency", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200, statusText: "OK" })),
    );
    const result = await httpConnector.check("https://example.com", config(), {}, ctx);
    expect(result.status).toBe("up");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.raw.httpStatus).toBe(200);
  });

  it("reports degraded when latency exceeds the threshold", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    );
    const result = await httpConnector.check(
      "https://example.com",
      config({ degradedAboveMs: -1 }),
      {},
      ctx,
    );
    expect(result.status).toBe("degraded");
  });

  it("reports down when the status code does not match", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("err", { status: 500, statusText: "Server Error" })),
    );
    const result = await httpConnector.check("https://example.com", config(), {}, ctx);
    expect(result.status).toBe("down");
    expect(result.message).toContain("erwartet 200");
  });

  it("reports down with null latency on timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
      }),
    );
    const result = await httpConnector.check("https://slow.example", config(), {}, ctx);
    expect(result.status).toBe("down");
    expect(result.latencyMs).toBeNull();
    expect(result.message).toContain("Zeitüberschreitung");
  });
});
