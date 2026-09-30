import * as v from "valibot";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CheckContext } from "../types";
import { checkmkConnector } from "./checkmk.connector";

const ctx: CheckContext = { signal: new AbortController().signal, now: new Date() };
const config = (o: Record<string, unknown> = {}) =>
  v.parse(checkmkConnector.configSchema, o) as any;
const secrets = {
  serverUrl: "https://ops.example.test",
  site: "main",
  username: "automation",
  automationSecret: "secret",
};

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(handler: (url: string) => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => handler(String(url))),
  );
}

function hostResp(state: number) {
  return json({ value: [{ extensions: { name: "web.example.test", state } }] });
}
function svcResp(states: number[]) {
  return json({
    value: states.map((state, i) => ({
      extensions: { description: `Service ${i}`, state, plugin_output: "out" },
    })),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("checkmkConnector.check", () => {
  it("reports up when host is UP and all services OK", async () => {
    stubFetch((url) => (url.includes("/service/") ? svcResp([0, 0, 0]) : hostResp(0)));
    const result = await checkmkConnector.check("web.example.test", config(), secrets, ctx);
    expect(result.status).toBe("up");
    expect((result.raw as any).counts.ok).toBe(3);
    expect((result.raw as any).host.state).toBe(0);
  });

  it("reports degraded on a WARN service", async () => {
    stubFetch((url) => (url.includes("/service/") ? svcResp([0, 1]) : hostResp(0)));
    const result = await checkmkConnector.check("web.example.test", config(), secrets, ctx);
    expect(result.status).toBe("degraded");
  });

  it("reports down on a CRIT service", async () => {
    stubFetch((url) => (url.includes("/service/") ? svcResp([0, 2]) : hostResp(0)));
    const result = await checkmkConnector.check("web.example.test", config(), secrets, ctx);
    expect(result.status).toBe("down");
  });

  it("reports down when the host is DOWN", async () => {
    stubFetch((url) => (url.includes("/service/") ? svcResp([0]) : hostResp(1)));
    const result = await checkmkConnector.check("web.example.test", config(), secrets, ctx);
    expect(result.status).toBe("down");
  });

  it("reports down on auth failure", async () => {
    stubFetch(() => json({ title: "Unauthorized" }, 401));
    const result = await checkmkConnector.check("web.example.test", config(), secrets, ctx);
    expect(result.status).toBe("down");
    expect(result.message).toBe("Authentifizierung fehlgeschlagen");
  });

  it("skips services when includeServices is false", async () => {
    const fetchSpy = vi.fn(async () => hostResp(0));
    vi.stubGlobal("fetch", fetchSpy);
    const result = await checkmkConnector.check(
      "web.example.test",
      config({ includeServices: false }),
      secrets,
      ctx,
    );
    expect(result.status).toBe("up");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("checkmkConnector.discover", () => {
  it("returns monitored hosts as discovered assets", async () => {
    stubFetch(() =>
      json({
        value: [
          { extensions: { name: "ops.example.test" } },
          { extensions: { name: "web.example.test" } },
          { extensions: { name: "mail.example.test" } },
        ],
      }),
    );
    const found = await checkmkConnector.discover!(config(), secrets, ctx);
    expect(found).toHaveLength(3);
    expect(found.map((f) => f.target)).toContain("mail.example.test");
    expect(found[0]).toEqual({ name: "ops.example.test", target: "ops.example.test" });
  });

  it("normalizes a server URL that already includes the site or check_mk path", async () => {
    let calledUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        calledUrl = String(url);
        return json({ value: [] });
      }),
    );
    // Empty value -> connected but zero hosts -> throws after trying both paths.
    await expect(
      checkmkConnector.discover!(
        config(),
        { ...secrets, serverUrl: "https://ops.example.test/demo/check_mk/", site: "demo" },
        ctx,
      ),
    ).rejects.toThrow(/0 hosts/);
    expect(calledUrl).toContain(
      "https://ops.example.test/demo/check_mk/api/1.0/domain-types/host_config/collections/all",
    );
    expect(calledUrl).not.toContain("/demo/demo/");
  });

  it("throws a descriptive error with the tried URL on failure", async () => {
    stubFetch(() => json({ title: "Not Found" }, 404));
    await expect(checkmkConnector.discover!(config(), secrets, ctx)).rejects.toThrow(/404/);
  });
});
