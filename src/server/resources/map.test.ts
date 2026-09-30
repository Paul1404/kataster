import { describe, expect, it } from "vitest";
import {
  awsTenantSeeds,
  mailboxResourceSeeds,
  matchTenantToCustomer,
  railwayResourceSeeds,
} from "./map";

const CUSTOMERS = [
  { id: "c-schloss", name: "Kulturzentrum Musterhausen" },
  { id: "c-svu", name: "Sportverein 1945 Beispielstadt e.V." },
  { id: "c-weng", name: "Alex Beispiel - Beispielwerk GbR" },
  { id: "c-ele", name: "Julia Muster - Testportal" },
  { id: "c-pdcd", name: "Example Hosting - Internal Domains and Infrastructure" },
  { id: "c-pfarrei", name: "Pfarrei St. Beispiel, Musterstadt" },
  { id: "c-aws", name: "Amazon Web Services EMEA SARL" },
];

describe("matchTenantToCustomer", () => {
  it("matches tenants whose name shares strong tokens with a customer", () => {
    expect(matchTenantToCustomer("Tenant-Kulturzentrum-Musterhausen", CUSTOMERS)).toBe("c-schloss");
    expect(matchTenantToCustomer("Tenant-Sportverein-SV-Beispielstadt", CUSTOMERS)).toBe("c-svu");
    expect(matchTenantToCustomer("Tenant-Beispielwerk", CUSTOMERS)).toBe("c-weng");
    expect(matchTenantToCustomer("Tenant-Testportal", CUSTOMERS)).toBe("c-ele");
  });

  it("returns null when no confident match exists", () => {
    // Generic tokens (personal/digital/services) must not match, e.g. never onto
    // "Amazon Web Services EMEA SARL" via "services".
    expect(matchTenantToCustomer("Tenant-Personal-Digital-Services", CUSTOMERS)).toBeNull();
    // The parish grouping is a different entity than the listed parish.
    expect(matchTenantToCustomer("Tenant-Pfarreiengemeinschaft-St-Muster", CUSTOMERS)).toBeNull();
    expect(matchTenantToCustomer("Tenant-Unknowncorp", CUSTOMERS)).toBeNull();
  });
});

describe("awsTenantSeeds", () => {
  it("maps tenants to owners and preserves their owner on re-sync", () => {
    const seeds = awsTenantSeeds({
      tenants: [
        { name: "Tenant-Kulturzentrum-Musterhausen", id: "tn-abc", arn: "arn:...:tenant/x" },
        { name: "Tenant-Personal-Digital-Services", id: "tn-pds", arn: "arn:...:tenant/y" },
      ],
      customers: CUSTOMERS,
    });
    const schloss = seeds.find((s) => s.externalId === "tn-abc")!;
    expect(schloss.type).toBe("ses_tenant");
    expect(schloss.ownerCustomerId).toBe("c-schloss");
    expect(schloss.preserveOwner).toBe(true);
    expect(seeds.find((s) => s.externalId === "tn-pds")!.ownerCustomerId).toBeNull();
  });
});

describe("mailboxResourceSeeds", () => {
  it("gives a mailbox its own owner and links it to its domain", () => {
    const seeds = mailboxResourceSeeds([
      {
        address: "alice@example.com",
        domainName: "example.com",
        customerId: "c-ele",
        name: "Alice",
        active: true,
        quotaUsedBytes: 100,
      },
    ]);
    const mailbox = seeds[0]!;
    expect(mailbox.type).toBe("mailbox");
    // `resources` owns ownership. Mirroring the mailcow table would wipe an owner
    // set in the UI on the next sync, and the worker would re-suggest a different
    // one a minute later (owner thrash, once per check).
    expect(mailbox.preserveOwner).toBe(true);
    // Mailbox owner differs from its domain owner -- the core attribution case.
    expect(mailbox.ownerCustomerId).toBe("c-ele");
    expect(mailbox.parentExternalId).toBe("example.com");
    expect(mailbox.metadata.domainName).toBe("example.com");
  });
});

describe("railwayResourceSeeds", () => {
  it("emits projects with their services linked", () => {
    const seeds = railwayResourceSeeds([
      { id: "p1", name: "svufo", services: [{ id: "s1", name: "web" }] },
    ]);
    expect(seeds.find((s) => s.type === "railway_project")!.externalId).toBe("p1");
    const svc = seeds.find((s) => s.type === "railway_service")!;
    expect(svc.externalId).toBe("s1");
    expect(svc.parentExternalId).toBe("p1");
    expect(svc.metadata.projectId).toBe("p1");
  });
});
