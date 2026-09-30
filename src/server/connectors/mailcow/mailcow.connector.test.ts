import * as v from "valibot";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CheckContext } from "../types";
import { mailcowConnector } from "./mailcow.connector";

const ctx: CheckContext = { signal: new AbortController().signal, now: new Date() };
const cfg = v.parse(mailcowConnector.configSchema, {}) as any;
const secrets = { apiKey: "test-key" };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Route a mocked fetch by mailcow endpoint path.
function mockApi(routes: Record<string, unknown>, containerStatus = 200) {
  return vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/status/containers")) {
      if (containerStatus !== 200) return new Response("no", { status: containerStatus });
      return json(routes.containers);
    }
    if (url.includes("/status/version")) return json(routes.version);
    if (url.includes("/domain/all")) return json(routes.domains);
    if (url.includes("/mailbox/all")) return json(routes.mailboxes);
    if (url.includes("/alias/all")) return json(routes.aliases);
    if (url.includes("/status/vmail")) return json(routes.vmail);
    if (url.includes("/mailq/all")) return json(routes.mailq);
    return json(null, 404);
  });
}

afterEach(() => vi.unstubAllGlobals());

const HEALTHY = {
  containers: { "nginx-mailcow": { state: "running" }, "dovecot-mailcow": { state: "running" } },
  version: { version: "2026-05c" },
  domains: [
    {
      domain_name: "a.com",
      active: "1",
      mboxes_in_domain: 3,
      aliases_in_domain: 5,
      bytes_total: 1000,
      msgs_total: 12,
    },
    {
      domain_name: "b.com",
      active: "1",
      mboxes_in_domain: 1,
      aliases_in_domain: 0,
      bytes_total: 50,
      msgs_total: 2,
    },
  ],
  mailboxes: [
    { username: "x@a.com", active: "1", quota_used: 500, messages: 10 },
    { username: "y@a.com", active: "1", quota_used: 200, messages: 2 },
  ],
  aliases: [{}, {}, {}],
  vmail: { used: "39G", total: "124G", used_percent: "31%" },
  mailq: [],
};

describe("mailcowConnector.check (in-depth)", () => {
  it("aggregates domains, mailboxes, aliases, storage when healthy", async () => {
    vi.stubGlobal("fetch", mockApi(HEALTHY));
    const r = await mailcowConnector.check("mail.example.com", cfg, secrets, ctx);
    expect(r.status).toBe("up");
    expect(r.message).toContain("2 Domains");
    expect(r.message).toContain("2 Postfächer");
    expect(r.raw.version).toBe("2026-05c");
    expect((r.raw.domains as any).count).toBe(2);
    expect((r.raw.domains as any).list[0]).toMatchObject({
      name: "a.com",
      mailboxes: 3,
      aliases: 5,
    });
    expect(r.raw.mailboxes as any).toMatchObject({ count: 2, quotaUsedBytes: 700, messages: 12 });
    expect((r.raw.aliases as any).count).toBe(3);
    expect((r.raw.storage as any).usedPercent).toBe("31%");
  });

  it("degrades when a container is down", async () => {
    vi.stubGlobal(
      "fetch",
      mockApi({
        ...HEALTHY,
        containers: {
          "nginx-mailcow": { state: "running" },
          "dovecot-mailcow": { state: "exited" },
        },
      }),
    );
    const r = await mailcowConnector.check("mail.example.com", cfg, secrets, ctx);
    expect(r.status).toBe("degraded");
  });

  it("degrades when disk usage is high", async () => {
    vi.stubGlobal(
      "fetch",
      mockApi({ ...HEALTHY, vmail: { used: "120G", total: "124G", used_percent: "97%" } }),
    );
    const r = await mailcowConnector.check("mail.example.com", cfg, secrets, ctx);
    expect(r.status).toBe("degraded");
  });

  it("still reports core health when enrichment endpoints fail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes("/status/containers")) return json(HEALTHY.containers);
        return new Response("err", { status: 500 }); // every enrichment endpoint fails
      }),
    );
    const r = await mailcowConnector.check("mail.example.com", cfg, secrets, ctx);
    expect(r.status).toBe("up");
    expect((r.raw.domains as any).count).toBe(0);
  });

  it("reports down on auth failure", async () => {
    vi.stubGlobal("fetch", mockApi(HEALTHY, 403));
    const r = await mailcowConnector.check("mail.example.com", cfg, secrets, ctx);
    expect(r.status).toBe("down");
    expect(r.message).toContain("Authentifizierung");
  });
});
