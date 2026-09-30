import { describe, expect, it } from "vitest";
import { rawRetentionCutoff } from "./retention";

describe("rawRetentionCutoff", () => {
  it("uses complete UTC hours so a rollup bucket is never split between runs", () => {
    expect(rawRetentionCutoff(new Date("2026-07-26T12:34:56.000Z"), 14).toISOString()).toBe(
      "2026-07-12T12:00:00.000Z",
    );
  });

  it("clamps invalid or zero retention", () => {
    const now = new Date("2026-07-26T12:00:00.000Z");
    expect(rawRetentionCutoff(now, 0).toISOString()).toBe("2026-07-25T12:00:00.000Z");
    expect(rawRetentionCutoff(now, Number.NaN).toISOString()).toBe("2026-07-25T12:00:00.000Z");
  });
});
