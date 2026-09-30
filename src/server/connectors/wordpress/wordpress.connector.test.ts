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
