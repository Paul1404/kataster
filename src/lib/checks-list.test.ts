import { describe, expect, it } from "vitest";
import { checkSubtitle, sortChecks } from "./checks-list";

describe("sortChecks", () => {
  it("puts problems first, then sorts by name", () => {
    const rows = [
      { name: "b", lastStatus: "up" as const },
      { name: "a", lastStatus: "up" as const },
      { name: "z", lastStatus: "degraded" as const },
      { name: "y", lastStatus: "down" as const },
      { name: "x", lastStatus: "unknown" as const },
    ];
    expect(sortChecks(rows).map((r) => r.name)).toEqual(["y", "z", "x", "a", "b"]);
  });
});

describe("checkSubtitle", () => {
  it("drops the target when the name already contains its host", () => {
    expect(
      checkSubtitle({
        name: "museum.example.test / Website",
        target: "https://museum.example.test",
        connectorName: "HTTP / Website",
        kind: "probe",
      }),
    ).toBe("HTTP / Website");
  });

  it("keeps the target when the name does not say it", () => {
    expect(
      checkSubtitle({
        name: "Mailserver",
        target: "mail.example.test",
        connectorName: "Mailcow",
        kind: "probe",
      }),
    ).toBe("Mailcow · mail.example.test");
  });

  it("never shows a source's placeholder target", () => {
    expect(checkSubtitle({ name: "AWS", target: "*", connectorName: "AWS", kind: "source" })).toBe(
      "AWS",
    );
  });
});
