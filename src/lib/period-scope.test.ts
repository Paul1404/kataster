import { describe, expect, it } from "vitest";
import { periodScopedKey } from "./period-scope";

describe("periodScopedKey", () => {
  it("changes component identity when the selected financial period changes", () => {
    expect(periodScopedKey("2026-06", "customer-1")).not.toBe(
      periodScopedKey("2026-07", "customer-1"),
    );
  });
});
