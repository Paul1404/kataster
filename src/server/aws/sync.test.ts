import { describe, expect, it } from "vitest";
import { mergeAwsInventory } from "./sync";

const ASSET = "asset-1";

describe("mergeAwsInventory", () => {
  it("folds DNS, registry and SES into one row per domain name", () => {
    const raw = {
      zones: {
        list: [
          {
            name: "example.com.",
            zoneId: "Z1",
            private: false,
            recordCount: 12,
            findings: [{}, {}],
          },
        ],
      },
      registry: {
        list: [
          {
            name: "example.com",
            registrar: "Amazon Registrar",
            expiresAt: "2027-01-01T00:00:00.000Z",
            autoRenew: true,
            transferLock: false,
          },
        ],
      },
      ses: {
        region: "eu-central-1",
        list: [{ name: "example.com", type: "DOMAIN", verified: true, sendingEnabled: true }],
      },
    };
    const { domainRows, hasDns, hasRegistry, hasSes } = mergeAwsInventory(ASSET, raw);
    expect(hasDns && hasRegistry && hasSes).toBe(true);
    expect(domainRows).toHaveLength(1);
    const row = domainRows[0]!;
    expect(row.name).toBe("example.com");
    expect(row.hostedZoneId).toBe("Z1");
    expect(row.recordCount).toBe(12);
    expect(row.findingCount).toBe(2);
    expect(row.registered).toBe(true);
    expect(row.autoRenew).toBe(true);
    expect(row.registryExpiresAt).toBeInstanceOf(Date);
    expect(row.sesVerified).toBe(true);
    expect(row.sesRegion).toBe("eu-central-1");
  });

  it("normalizes names (lowercase, no trailing dot) so blocks merge", () => {
    const raw = {
      zones: { list: [{ name: "Example.COM.", zoneId: "Z1" }] },
      registry: {
        list: [
          {
            name: "example.com",
            registrar: null,
            expiresAt: null,
            autoRenew: null,
            transferLock: null,
          },
        ],
      },
    };
    const { domainRows } = mergeAwsInventory(ASSET, raw);
    expect(domainRows).toHaveLength(1);
    expect(domainRows[0]!.name).toBe("example.com");
  });

  it("flags which blocks ran so the caller can avoid nulling absent services", () => {
    const onlySes = mergeAwsInventory(ASSET, {
      ses: {
        region: "eu-central-1",
        list: [{ name: "a.com", type: "DOMAIN", verified: false, sendingEnabled: false }],
      },
    });
    expect(onlySes.hasDns).toBe(false);
    expect(onlySes.hasRegistry).toBe(false);
    expect(onlySes.hasSes).toBe(true);
    // A failed/absent DNS block leaves zone columns untouched on the merged row.
    expect(onlySes.domainRows[0]!.hostedZoneId).toBeUndefined();
  });

  it("ignores non-DOMAIN SES identities", () => {
    const { domainRows } = mergeAwsInventory(ASSET, {
      ses: {
        region: "eu-central-1",
        list: [{ name: "me@a.com", type: "EMAIL_ADDRESS", verified: true, sendingEnabled: true }],
      },
    });
    expect(domainRows).toHaveLength(0);
  });

  it("builds web distribution rows and skips them when the block is absent", () => {
    const withWeb = mergeAwsInventory(ASSET, {
      web: {
        list: [
          {
            distributionId: "E1",
            aliases: ["a.com"],
            primaryAlias: "a.com",
            originDomain: "x.s3-website.amazonaws.com",
            behavior: "redirect",
            enabled: true,
            status: "Deployed",
          },
        ],
      },
    });
    expect(withWeb.hasWeb).toBe(true);
    expect(withWeb.webRows).toHaveLength(1);
    expect(withWeb.webRows[0]!.behavior).toBe("redirect");

    const noWeb = mergeAwsInventory(ASSET, {});
    expect(noWeb.hasWeb).toBe(false);
    expect(noWeb.webRows).toHaveLength(0);
  });
});
