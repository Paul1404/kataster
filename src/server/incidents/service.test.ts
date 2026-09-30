import { describe, expect, it } from "vitest";
import { incidentAction } from "./service";

describe("incidentAction", () => {
  it("opens an incident on healthy -> unhealthy", () => {
    expect(incidentAction("up", "down", false)).toEqual({ type: "open", status: "down" });
    expect(incidentAction("up", "degraded", false)).toEqual({ type: "open", status: "degraded" });
  });

  it("does not open while suppressed (muted / maintenance)", () => {
    expect(incidentAction("up", "down", true)).toEqual({ type: "none" });
  });

  it("closes on recovery to up", () => {
    expect(incidentAction("down", "up", false)).toEqual({ type: "close" });
    // close is emitted even from healthy->up; the DB update is a no-op if none open
    expect(incidentAction("up", "up", false)).toEqual({ type: "close" });
  });

  it("escalates degraded -> down", () => {
    expect(incidentAction("degraded", "down", false)).toEqual({ type: "escalate", status: "down" });
  });

  it("treats first-ever check (prev unknown) as openable", () => {
    expect(incidentAction("unknown", "down", false)).toEqual({ type: "open", status: "down" });
  });

  it("never opens or closes on a transition to unknown", () => {
    expect(incidentAction("up", "unknown", false)).toEqual({ type: "none" });
    expect(incidentAction("down", "unknown", false)).toEqual({ type: "none" });
  });
});
