import * as v from "valibot";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CheckContext } from "../types";

// --- Mock the four AWS SDK clients. Each Command carries a tag; each client's
// send() routes on that tag and returns canned data. ---

const sendImpls: Record<string, (input: any) => any> = {};
function cmd(tag: string) {
  return class {
    input: any;
    __tag = tag;
    constructor(input: any) {
      this.input = input;
    }
  };
}
function client() {
  return class {
    async send(command: any) {
      const impl = sendImpls[command.__tag];
      if (!impl) throw new Error(`no mock for ${command.__tag}`);
      return impl(command.input);
    }
  };
}

vi.mock("@aws-sdk/client-route-53", () => ({
  Route53Client: client(),
  ListHostedZonesCommand: cmd("ListHostedZones"),
  ListResourceRecordSetsCommand: cmd("ListResourceRecordSets"),
  GetDNSSECCommand: cmd("GetDNSSEC"),
}));
vi.mock("@aws-sdk/client-route-53-domains", () => ({
  Route53DomainsClient: client(),
  ListDomainsCommand: cmd("ListDomains"),
}));
vi.mock("@aws-sdk/client-cloudfront", () => ({
  CloudFrontClient: client(),
  ListDistributionsCommand: cmd("ListDistributions"),
}));
vi.mock("@aws-sdk/client-sesv2", () => ({
  SESv2Client: client(),
  ListEmailIdentitiesCommand: cmd("ListEmailIdentities"),
  ListTenantsCommand: cmd("ListTenants"),
}));
vi.mock("@aws-sdk/client-acm", () => ({
  ACMClient: client(),
  ListCertificatesCommand: cmd("ListCertificates"),
}));

// Avoid real DNS lookups; return the zone's own NS so delegation matches.
vi.mock("node:dns/promises", () => ({ resolveNs: vi.fn(async () => ["ns-1.awsdns.com."]) }));

const { awsConnector, parseCeTotal } = await import("./aws.connector");

const ctx: CheckContext = {
  signal: new AbortController().signal,
  now: new Date("2026-06-28T00:00:00Z"),
};
const secrets = { accessKeyId: "k", secretAccessKey: "s", region: "us-east-1" };
// Tenants default off here so the many single-service tests don't each need a
// ListTenants mock; the dedicated tenants test opts in.
const cfg = (over: Record<string, unknown> = {}) =>
  v.parse(awsConnector.configSchema, { checkDnssec: false, pullTenants: false, ...over }) as any;

function setMocks(m: Partial<Record<string, (input: any) => any>>) {
  for (const k of Object.keys(sendImpls)) delete sendImpls[k];
  Object.assign(sendImpls, m);
}

afterEach(() => {
  for (const k of Object.keys(sendImpls)) delete sendImpls[k];
});

const HEALTHY_ZONE = {
  ListHostedZones: () => ({
    HostedZones: [{ Id: "/hostedzone/Z1", Name: "example.com.", Config: { PrivateZone: false } }],
  }),
  ListResourceRecordSets: () => ({
    ResourceRecordSets: [
      {
        Name: "example.com.",
        Type: "NS",
        TTL: 3600,
        ResourceRecords: [{ Value: "ns-1.awsdns.com." }],
      },
      { Name: "example.com.", Type: "SOA", TTL: 900, ResourceRecords: [{ Value: "ns-1." }] },
      { Name: "example.com.", Type: "A", TTL: 300, ResourceRecords: [{ Value: "1.2.3.4" }] },
    ],
  }),
};

describe("awsConnector", () => {
  it("is healthy when every service returns clean data", async () => {
    setMocks({
      ...HEALTHY_ZONE,
      ListDomains: () => ({
        Domains: [
          {
            DomainName: "example.com",
            Expiry: new Date("2028-01-01"),
            AutoRenew: true,
            TransferLock: true,
          },
        ],
      }),
      ListDistributions: () => ({ DistributionList: { Items: [] } }),
      ListEmailIdentities: () => ({
        EmailIdentities: [
          {
            IdentityName: "example.com",
            IdentityType: "DOMAIN",
            VerificationStatus: "SUCCESS",
            SendingEnabled: true,
          },
        ],
      }),
      ListCertificates: () => ({ CertificateSummaryList: [] }),
    });
    const r = await awsConnector.check("*", cfg(), secrets, ctx);
    expect(r.status).toBe("up");
    const raw = r.raw as any;
    expect(raw.zones.count).toBe(1);
    expect(raw.registry.count).toBe(1);
    expect(raw.ses.list[0].name).toBe("example.com");
  });

  it("flags a domain expiring within 30 days and auto-renew off", async () => {
    setMocks({
      ListDomains: () => ({
        Domains: [
          {
            DomainName: "soon.com",
            Expiry: new Date("2026-07-10"),
            AutoRenew: false,
            TransferLock: false,
          },
        ],
      }),
    });
    const r = await awsConnector.check(
      "*",
      cfg({ pullDns: false, pullWeb: false, pullSes: false, pullCerts: false }),
      secrets,
      ctx,
    );
    expect(r.status).toBe("degraded");
    const codes = (r.raw as any).findings.map((f: any) => f.code);
    expect(codes).toContain("registry_expiring");
    expect(codes).toContain("registry_autorenew_off");
  });

  it("infers a CloudFront redirect from an s3-website origin", async () => {
    setMocks({
      ListDistributions: () => ({
        DistributionList: {
          Items: [
            {
              Id: "E1",
              Enabled: true,
              Status: "Deployed",
              Aliases: { Items: ["redir.com"] },
              Origins: { Items: [{ DomainName: "bucket.s3-website-eu.amazonaws.com" }] },
            },
          ],
        },
      }),
    });
    const r = await awsConnector.check(
      "*",
      cfg({ pullDns: false, pullRegistry: false, pullSes: false, pullCerts: false }),
      secrets,
      ctx,
    );
    expect((r.raw as any).web.list[0].behavior).toBe("redirect");
  });

  it("collects ACM certs and flags imminent expiry", async () => {
    setMocks({
      ListCertificates: () => ({
        CertificateSummaryList: [
          {
            DomainName: "Soon.com.",
            NotAfter: new Date("2026-07-05"),
            SubjectAlternativeNameSummaries: ["soon.com", "www.soon.com"],
            Status: "ISSUED",
          },
        ],
      }),
    });
    const r = await awsConnector.check(
      "*",
      cfg({ pullDns: false, pullRegistry: false, pullWeb: false, pullSes: false }),
      secrets,
      ctx,
    );
    const raw = r.raw as any;
    expect(raw.certs.list[0].commonName).toBe("soon.com");
    expect(r.status).toBe("degraded");
    expect(raw.findings.map((f: any) => f.code)).toContain("cert_expiring");
  });

  it("degrades (not down) when one service fails but others succeed", async () => {
    setMocks({
      ...HEALTHY_ZONE,
      ListDomains: () => {
        throw new Error("AccessDenied");
      },
      ListDistributions: () => ({ DistributionList: { Items: [] } }),
      ListEmailIdentities: () => ({ EmailIdentities: [] }),
    });
    const r = await awsConnector.check("*", cfg(), secrets, ctx);
    expect(r.status).toBe("degraded");
    expect((r.raw as any).registry).toBeUndefined();
    expect((r.raw as any).zones.count).toBe(1);
  });

  it("collects SES tenants when enabled", async () => {
    setMocks({
      ListTenants: () => ({
        Tenants: [
          {
            TenantName: "Tenant-Kulturzentrum-Musterhausen",
            TenantId: "tn-abc",
            TenantArn: "arn:aws:ses:eu-central-1:1:tenant/Tenant-Kulturzentrum-Musterhausen/tn-abc",
          },
        ],
      }),
    });
    const r = await awsConnector.check(
      "*",
      cfg({
        pullDns: false,
        pullRegistry: false,
        pullWeb: false,
        pullSes: false,
        pullCerts: false,
        pullTenants: true,
      }),
      secrets,
      ctx,
    );
    const raw = r.raw as any;
    expect(raw.tenants.count).toBe(1);
    expect(raw.tenants.list[0].name).toBe("Tenant-Kulturzentrum-Musterhausen");
    expect(raw.tenants.list[0].id).toBe("tn-abc");
  });

  it("parses a Cost Explorer total into cents", () => {
    expect(
      parseCeTotal([{ Total: { UnblendedCost: { Amount: "12.3456", Unit: "USD" } } }]),
    ).toEqual({ amountCents: 1235, currency: "USD" });
    expect(parseCeTotal(undefined)).toEqual({ amountCents: 0, currency: "USD" });
  });

  it("is down when every enabled service fails (bad credentials)", async () => {
    setMocks({
      ListHostedZones: () => {
        throw new Error("InvalidClientTokenId");
      },
      ListDomains: () => {
        throw new Error("InvalidClientTokenId");
      },
    });
    const r = await awsConnector.check(
      "*",
      cfg({ pullWeb: false, pullSes: false, pullCerts: false }),
      secrets,
      ctx,
    );
    expect(r.status).toBe("down");
  });
});
