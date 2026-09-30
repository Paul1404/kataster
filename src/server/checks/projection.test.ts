import { describe, expect, it } from "vitest";
import { recordProjectionFailure, recordProjectionSuccess } from "./projection";

const at = new Date("2026-07-26T08:00:00.000Z");

describe("projection status", () => {
  it("degrades a green probe and preserves structured failure detail", () => {
    const result = recordProjectionFailure(
      { status: "up", latencyMs: 12, message: null, raw: { provider: "aws" } },
      "aws.inventory",
      new Error("database unavailable"),
      at,
    );

    expect(result.status).toBe("degraded");
    expect(result.message).toBe("aws.inventory fehlgeschlagen");
    expect(result.raw).toMatchObject({
      provider: "aws",
      sync: {
        ok: false,
        stages: {
          "aws.inventory": {
            ok: false,
            checkedAt: at.toISOString(),
            error: "database unavailable",
          },
        },
      },
    });
  });

  it("does not mask an already-down probe and accumulates stage results", () => {
    const initial = { status: "down" as const, latencyMs: null, message: "probe failed", raw: {} };
    const successful = recordProjectionSuccess(initial, "aws.inventory", at);
    const failed = recordProjectionFailure(successful, "cost.allocation", "write failed", at);

    expect(failed.status).toBe("down");
    expect(failed.message).toBe("probe failed; Kostenverteilung fehlgeschlagen");
    expect(failed.raw.sync).toMatchObject({
      ok: false,
      stages: {
        "aws.inventory": { ok: true },
        "cost.allocation": { ok: false, error: "write failed" },
      },
    });
  });

  it("keeps the database cause instead of the whole failed query", () => {
    const pg = new Error("ON CONFLICT DO UPDATE command cannot affect row a second time");
    const wrapped = new Error(
      `Failed query: insert into "cost_allocations" ${"x".repeat(30_000)}`,
      {
        cause: pg,
      },
    );
    const failed = recordProjectionFailure(
      { status: "up", latencyMs: 1, message: null, raw: {} },
      "cost.allocation",
      wrapped,
      at,
    );
    expect(failed.raw.sync).toMatchObject({
      stages: { "cost.allocation": { error: pg.message } },
    });
  });
});
