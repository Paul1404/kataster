import { describe, expect, it } from "vitest";
import { readJsonBody } from "./json-body";

describe("readJsonBody", () => {
  it("parses a body within the byte limit", async () => {
    const request = new Request("https://lfio.test/api", {
      method: "POST",
      body: JSON.stringify({ ok: true }),
    });
    await expect(readJsonBody(request, 100)).resolves.toEqual({ ok: true });
  });

  it("rejects oversized streamed bodies even without Content-Length", async () => {
    const request = new Request("https://lfio.test/api", {
      method: "POST",
      body: JSON.stringify({ value: "x".repeat(100) }),
    });
    await expect(readJsonBody(request, 20)).rejects.toMatchObject({ status: 413 });
  });
});
