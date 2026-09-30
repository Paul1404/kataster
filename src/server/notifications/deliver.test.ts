import { afterEach, describe, expect, it, vi } from "vitest";
import { buildWebhookPayload, postWebhook } from "./deliver";
import type { NotificationEvent } from "./events";

const EVENT: NotificationEvent = {
  channelId: "chan-1",
  ruleKind: "incident_opened",
  dedupeKey: "chan-1:incident_opened:inc-1",
  title: "Ausfall: mail.example.test",
  body: "mail.example.test ist seit 2 h nicht erreichbar. Meldung: SMTP timeout",
};
const SENT_AT = new Date("2026-09-13T10:00:00.000Z");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildWebhookPayload", () => {
  it("carries the fields ntfy, Slack and Discord each look for", () => {
    const payload = buildWebhookPayload(EVENT, SENT_AT);
    // ntfy: title + message. Slack: text. Discord: content.
    expect(payload.title).toBe(EVENT.title);
    expect(payload.message).toBe(EVENT.body);
    expect(payload.text).toBe(`${EVENT.title}\n${EVENT.body}`);
    expect(payload.content).toBe(payload.text);
    expect(payload.ruleKind).toBe("incident_opened");
    expect(payload.dedupeKey).toBe(EVENT.dedupeKey);
    expect(payload.sentAt).toBe("2026-09-13T10:00:00.000Z");
  });
});

describe("postWebhook", () => {
  it("posts JSON with the title header", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));

    await postWebhook("https://ntfy.example/kataster", buildWebhookPayload(EVENT, SENT_AT));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://ntfy.example/kataster");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["X-Title"]).toBe(EVENT.title);
    expect(JSON.parse(String(init.body))).toMatchObject({
      title: EVENT.title,
      message: EVENT.body,
      content: `${EVENT.title}\n${EVENT.body}`,
    });
  });

  it("throws with the status and response text on a non-2xx answer", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("no such topic", { status: 404 }));
    await expect(
      postWebhook("https://ntfy.example/nope", buildWebhookPayload(EVENT, SENT_AT)),
    ).rejects.toThrow(/404 no such topic/);
  });

  it("keeps the title header on one line", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));
    const payload = buildWebhookPayload({ ...EVENT, title: "Zeile 1\nZeile 2" }, SENT_AT);
    await postWebhook("https://ntfy.example/kataster", payload);
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers["X-Title"]).toBe("Zeile 1 Zeile 2");
  });
});
