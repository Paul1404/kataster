import { ORPCError } from "@orpc/server";
import { eq, inArray, sql } from "drizzle-orm";
import * as v from "valibot";
import { db } from "../../db";
import { domains, webDistributions } from "../../db/schema/aws";
import { certificates } from "../../db/schema/certs";
import { customers } from "../../db/schema/customers";
import { mailDomains } from "../../db/schema/mail";
import { authed } from "../base";

interface DomainPane {
  name: string;
  customerId: string | null;
  locationName: string | null;
  hasDns: boolean;
  recordCount: number | null;
  dnssecEnabled: boolean | null;
  hasRegistry: boolean;
  registrar: string | null;
  registryExpiresAt: Date | null;
  autoRenew: boolean | null;
  transferLock: boolean | null;
  hasWeb: boolean;
  webBehavior: string | null;
  hasSesMail: boolean;
  hasMailcowMail: boolean;
  certExpiresAt: Date | null;
}

function normalize(name: string): string {
  return name.replace(/\.$/, "").toLowerCase();
}

async function assertLocation(customerId: string | null) {
  if (!customerId) return;
  const [loc] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.id, customerId));
  if (!loc) throw new ORPCError("NOT_FOUND", { message: "Kunde nicht gefunden" });
}

export const domainsRouter = {
  // The single pane: every known domain name with its DNS, registry, web and
  // email capabilities folded together and resolved to a customer location.
  list: authed.handler(async () => {
    const [awsRows, webRows, mailRows, certRows, locRows] = await Promise.all([
      db.select().from(domains),
      db
        .select({
          primaryAlias: webDistributions.primaryAlias,
          aliases: webDistributions.aliases,
          behavior: webDistributions.behavior,
          customerId: webDistributions.customerId,
        })
        .from(webDistributions),
      db
        .select({
          name: mailDomains.name,
          customerId: mailDomains.customerId,
        })
        .from(mailDomains),
      db
        .select({
          commonName: certificates.commonName,
          notAfter: certificates.notAfter,
          customerId: certificates.customerId,
        })
        .from(certificates),
      db.select({ id: customers.id, name: customers.name }).from(customers),
    ]);

    const locName = new Map(locRows.map((l) => [l.id, l.name]));
    const byName = new Map<string, DomainPane>();
    const ensure = (rawName: string): DomainPane => {
      const name = normalize(rawName);
      let row = byName.get(name);
      if (!row) {
        row = {
          name,
          customerId: null,
          locationName: null,
          hasDns: false,
          recordCount: null,
          dnssecEnabled: null,
          hasRegistry: false,
          registrar: null,
          registryExpiresAt: null,
          autoRenew: null,
          transferLock: null,
          hasWeb: false,
          webBehavior: null,
          hasSesMail: false,
          hasMailcowMail: false,
          certExpiresAt: null,
        };
        byName.set(name, row);
      }
      return row;
    };
    const setLocation = (row: DomainPane, customerId: string | null) => {
      if (customerId && !row.customerId) {
        row.customerId = customerId;
        row.locationName = locName.get(customerId) ?? null;
      }
    };

    for (const d of awsRows) {
      const row = ensure(d.name);
      row.hasDns = d.hostedZoneId != null;
      row.recordCount = d.recordCount;
      row.dnssecEnabled = d.dnssecEnabled;
      row.hasRegistry = d.registered;
      row.registrar = d.registrar;
      row.registryExpiresAt = d.registryExpiresAt;
      row.autoRenew = d.autoRenew;
      row.transferLock = d.transferLock;
      row.hasSesMail = d.sesVerified;
      setLocation(row, d.customerId);
    }
    for (const w of webRows) {
      const alias = w.primaryAlias ?? w.aliases[0];
      if (!alias) continue;
      const row = ensure(alias);
      row.hasWeb = true;
      row.webBehavior = w.behavior;
      setLocation(row, w.customerId);
    }
    for (const m of mailRows) {
      const row = ensure(m.name);
      row.hasMailcowMail = true;
      setLocation(row, m.customerId);
    }
    for (const c of certRows) {
      if (!c.commonName) continue;
      const row = ensure(c.commonName);
      // Keep the soonest expiry when a name has more than one cert (tls + acm).
      if (c.notAfter && (!row.certExpiresAt || c.notAfter < row.certExpiresAt)) {
        row.certExpiresAt = c.notAfter;
      }
      setLocation(row, c.customerId);
    }

    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }),

  // Assign every capability of the given domain names to a customer (or clear).
  assign: authed
    .input(
      v.object({
        names: v.pipe(v.array(v.string()), v.minLength(1)),
        customerId: v.nullable(v.string()),
      }),
    )
    .handler(async ({ input }) => {
      await assertLocation(input.customerId);
      const names = input.names.map(normalize);
      await db
        .update(domains)
        .set({ customerId: input.customerId })
        .where(inArray(sql`lower(${domains.name})`, names));
      await db
        .update(webDistributions)
        .set({ customerId: input.customerId })
        .where(inArray(sql`lower(${webDistributions.primaryAlias})`, names));
      await db
        .update(mailDomains)
        .set({ customerId: input.customerId })
        .where(inArray(sql`lower(${mailDomains.name})`, names));
      return { ok: true, count: names.length };
    }),

  // Mark a registered domain as decommissioned (or undo), suppressing its
  // expiry / auto-renew warnings on the dashboard.
  setDecommissioned: authed
    .input(v.object({ name: v.string(), value: v.boolean() }))
    .handler(async ({ input }) => {
      await db
        .update(domains)
        .set({ decommissioned: input.value })
        .where(eq(sql`lower(${domains.name})`, normalize(input.name)));
      return { ok: true };
    }),
};
