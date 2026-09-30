import { describe, expect, it } from "vitest";
import { toEurCents, USD_TO_EUR } from "./fx";

describe("toEurCents", () => {
  it("passes EUR through unchanged", () => {
    expect(toEurCents(3268, "EUR")).toBe(3268);
  });

  it("converts USD cents to EUR at the fixed rate, rounded", () => {
    expect(toEurCents(1000, "USD")).toBe(Math.round(1000 * USD_TO_EUR));
    expect(toEurCents(598, "USD")).toBe(Math.round(598 * USD_TO_EUR));
  });

  it("treats an unknown currency as already-EUR rather than dropping it", () => {
    expect(toEurCents(500, "GBP")).toBe(500);
  });
});
