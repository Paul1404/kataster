import { describe, expect, it } from "vitest";
import { parseHetznerCloudServers } from "./hetzner-cloud.connector";

describe("parseHetznerCloudServers", () => {
  it("extracts ip + hardware and the monthly price matching the server's location", () => {
    const out = parseHetznerCloudServers([
      {
        id: 42,
        name: "web",
        status: "running",
        public_net: { ipv4: { ip: "188.245.89.56" } },
        server_type: {
          name: "cax21",
          cores: 4,
          memory: 8,
          disk: 80,
          prices: [
            { location: "fsn1", price_monthly: { gross: "6.49", net: "5.45" } },
            { location: "hel1", price_monthly: { gross: "6.99", net: "5.87" } },
          ],
        },
        datacenter: { location: { name: "hel1" } },
      },
    ]);
    expect(out).toHaveLength(1);
    const s = out[0]!;
    expect(s.ipv4).toBe("188.245.89.56");
    expect(s.serverType).toBe("cax21");
    expect(s.cores).toBe(4);
    expect(s.memoryGb).toBe(8);
    expect(s.location).toBe("hel1");
    expect(s.monthlyPriceCents).toBe(699); // hel1 gross 6.99 -> cents
  });

  it("falls back to the first price when location doesn't match, and tolerates missing data", () => {
    const out = parseHetznerCloudServers([
      {
        id: 1,
        name: "x",
        status: "running",
        server_type: { prices: [{ location: "fsn1", price_monthly: { gross: "3.79" } }] },
      },
      { id: 2, name: "y", status: "off" },
    ]);
    expect(out[0]!.monthlyPriceCents).toBe(379);
    expect(out[0]!.ipv4).toBeNull();
    expect(out[1]!.monthlyPriceCents).toBeNull();
    expect(out[1]!.ipv4).toBeNull();
  });
});
