import * as v from "valibot";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CheckContext } from "../types";
import { wordpressConnector } from "./wordpress.connector";

const ctx: CheckContext = { signal: new AbortController().signal, now: new Date() };
const cfg = v.parse(wordpressConnector.configSchema, {}) as any;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("wordpressConnector.check", () => {
  it.each([
    "/wp-json/",
    "/?rest_route=/",
    "/cms/wp-json/?context=view",
  ])("requests only health metadata while preserving the configured path %s", async (apiPath) => {
    const fetchMock = vi.fn(async (_url: string | URL | Request) =>
      jsonResponse({ name: "My Blog", namespaces: ["wp/v2"] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const config = v.parse(wordpressConnector.configSchema, { apiPath });

    const result = await wordpressConnector.check("https://blog.example.com", config, {}, ctx);

    const actual = new URL(fetchMock.mock.calls[0]?.[0] as string);
    const expected = new URL(apiPath, "https://blog.example.com");
    expect(actual.pathname).toBe(expected.pathname);
    for (const [key, value] of expected.searchParams) {
      expect(actual.searchParams.get(key)).toBe(value);
    }
    expect(actual.searchParams.get("_fields")).toBe("name,namespaces");
    expect(result.status).toBe("up");
    expect(result.raw).toMatchObject({ siteName: "My Blog", namespaces: 1 });
  });

  it("reports up when /wp-json returns site info", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          name: "My Blog",
          description: "Hello",
          namespaces: ["oembed/1.0", "wp/v2"],
        }),
      ),
    );
    const r = await wordpressConnector.check("https://blog.example.com", cfg, {}, ctx);
    expect(r.status).toBe("up");
    expect(r.raw).toMatchObject({ siteName: "My Blog", namespaces: 2 });
  });

  it("reports down when the REST API is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ code: "rest_no_route" }, 404)),
    );
    const r = await wordpressConnector.check("https://blog.example.com", cfg, {}, ctx);
    expect(r.status).toBe("down");
  });

  it("reports degraded when slow", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ name: "Slow Site", namespaces: [] })),
    );
    const slow = v.parse(wordpressConnector.configSchema, { degradedAboveMs: -1 }) as any;
    const r = await wordpressConnector.check("https://blog.example.com", slow, {}, ctx);
    expect(r.status).toBe("degraded");
  });
});
