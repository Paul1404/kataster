import { ORPCError } from "@orpc/server";
import { and, asc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import * as v from "valibot";
import { resolveCharges } from "../../costs/billing";
import { periodOf, resolveAllocationsCents } from "../../costs/margin";
import { db } from "../../db";
import { assets } from "../../db/schema/assets";
import {
  contractPositions,
  costAllocations,
  customerPricing,
  providerCosts,
} from "../../db/schema/costs";
import { customerContacts, customers } from "../../db/schema/customers";
import { invoices } from "../../db/schema/invoices";
import { resources } from "../../db/schema/resources";
import { authed } from "../base";

const Latitude = v.pipe(v.number(), v.minValue(-90), v.maxValue(90));
const Longitude = v.pipe(v.number(), v.minValue(-180), v.maxValue(180));
const Kind = v.picklist([
  "provider",
  "customer_private",
  "customer_business",
  "internal",
  "partner",
]);
const Status = v.picklist(["active", "prospect", "churned"]);

const OptionalText = v.optional(v.nullable(v.pipe(v.string(), v.maxLength(500))));

const CreateInput = v.object({
  name: v.pipe(v.string(), v.minLength(1)),
  kind: v.optional(Kind),
  status: v.optional(Status),
  tags: v.optional(v.array(v.string())),
  notes: v.optional(v.nullable(v.string())),
  address: OptionalText,
  customerNumber: OptionalText,
  billingEmail: OptionalText,
  billingAddress: OptionalText,
  vatId: OptionalText,
  // Coordinates are optional: only placed customers appear on the map.
  latitude: v.optional(v.nullable(Latitude)),
  longitude: v.optional(v.nullable(Longitude)),
});

const UpdateInput = v.object({
  id: v.string(),
  name: v.optional(v.pipe(v.string(), v.minLength(1))),
  kind: v.optional(Kind),
  status: v.optional(Status),
  tags: v.optional(v.array(v.string())),
  notes: v.optional(v.nullable(v.string())),
  address: OptionalText,
  customerNumber: OptionalText,
  billingEmail: OptionalText,
  billingAddress: OptionalText,
  vatId: OptionalText,
  latitude: v.optional(v.nullable(Latitude)),
  longitude: v.optional(v.nullable(Longitude)),
});

const ContactInput = v.object({
  id: v.optional(v.string()),
  customerId: v.string(),
  name: v.pipe(v.string(), v.minLength(1)),
  email: v.optional(v.nullable(v.string())),
  phone: v.optional(v.nullable(v.string())),
  role: v.optional(v.nullable(v.string())),
  isPrimary: v.optional(v.boolean()),
});

// Per-customer capability rollup, derived from the owned resources. Mail is true
// when the customer owns a mailbox even if a different customer owns the domain.
const capabilityColumns = {
  hasDns: sql<boolean>`exists(select 1 from ${resources} r where r.owner_customer_id = ${customers}."id" and r.status = 'active' and r.type = 'dns_zone')`,
  hasRegistry: sql<boolean>`exists(select 1 from ${resources} r where r.owner_customer_id = ${customers}."id" and r.status = 'active' and r.type = 'registered_domain')`,
  hasWeb: sql<boolean>`exists(select 1 from ${resources} r where r.owner_customer_id = ${customers}."id" and r.status = 'active' and r.type in ('cloudfront_distribution','container','railway_service'))`,
  hasCloudfront: sql<boolean>`exists(select 1 from ${resources} r where r.owner_customer_id = ${customers}."id" and r.status = 'active' and r.type = 'cloudfront_distribution')`,
  hasMail: sql<boolean>`exists(select 1 from ${resources} r where r.owner_customer_id = ${customers}."id" and r.status = 'active' and r.type in ('mailbox','mail_domain','ses_identity','ses_tenant'))`,
  registryExpiresAt: sql<
    string | null
  >`(select min((r.metadata->>'registryExpiresAt')::timestamptz) from ${resources} r where r.owner_customer_id = ${customers}."id" and r.status = 'active' and r.type = 'registered_domain')`,
};

export const customersRouter = {
  list: authed.handler(async () => {
    return db
      .select({
        ...getTableColumns(customers),
        // Count the unified inventory owned by this customer (domains, zones, SES
        // identities/tenants, distributions, certs, mailboxes, containers, ...).
        resourceCount: sql<number>`(select count(*)::int from ${resources} where ${resources.ownerCustomerId} = ${customers}."id" and ${resources.status} = 'active')`,
        ...capabilityColumns,
      })
      .from(customers)
      .orderBy(customers.name);
  }),

  // Everything about one customer for the detail page: profile + capabilities,
  // owned inventory, monitored assets, contacts, and this period's cost/charge/
  // margin. One round-trip so the page never fans out a dozen queries.
  get: authed.input(v.object({ id: v.string() })).handler(async ({ input }) => {
    const [customer] = await db
      .select({ ...getTableColumns(customers), ...capabilityColumns })
      .from(customers)
      .where(eq(customers.id, input.id))
      .limit(1);
    if (!customer) throw new ORPCError("NOT_FOUND", { message: "Kunde nicht gefunden" });

    const period = periodOf(new Date());
    const [owned, ownedAssets, contacts, allocRows, poolRows, positionRows, adjustmentRows] =
      await Promise.all([
        db
          .select({
            id: resources.id,
            type: resources.type,
            provider: resources.provider,
            externalId: resources.externalId,
            name: resources.name,
            parentResourceId: resources.parentResourceId,
          })
          .from(resources)
          .where(eq(resources.ownerCustomerId, input.id))
          .orderBy(asc(resources.provider), asc(resources.type), asc(resources.name)),
        db
          .select({
            id: assets.id,
            name: assets.name,
            connectorId: assets.connectorId,
            lastStatus: assets.lastStatus,
            lastCheckedAt: assets.lastCheckedAt,
          })
          .from(assets)
          .where(eq(assets.customerId, input.id))
          .orderBy(asc(assets.name)),
        db
          .select()
          .from(customerContacts)
          .where(eq(customerContacts.customerId, input.id))
          .orderBy(asc(customerContacts.name)),
        db.select().from(costAllocations).where(eq(costAllocations.period, period)),
        db.select().from(providerCosts).where(eq(providerCosts.period, period)),
        db
          .select()
          .from(contractPositions)
          .where(eq(contractPositions.customerId, input.id))
          .orderBy(asc(contractPositions.startsPeriod), asc(contractPositions.label)),
        db
          .select({
            customerId: customerPricing.customerId,
            period: customerPricing.period,
            amountCents: customerPricing.amountCents,
            note: customerPricing.note,
          })
          .from(customerPricing)
          .where(and(eq(customerPricing.customerId, input.id), eq(customerPricing.period, period))),
      ]);

    // Cost = sum of allocations landing on this customer's resources (same
    // resolution the margin rollup uses); charge = the period's set price.
    const ownedIds = new Set(owned.map((r) => r.id));
    const resolved = resolveAllocationsCents(allocRows, poolRows);
    const costCents = allocRows.reduce(
      (s, a, i) => s + (ownedIds.has(a.resourceId) ? resolved[i]! : 0),
      0,
    );
    const charge = resolveCharges(period, positionRows, adjustmentRows).get(input.id);
    const chargeCents = charge?.amountCents ?? 0;

    return {
      ...customer,
      resources: owned,
      assets: ownedAssets,
      contacts,
      period,
      costCents,
      chargeCents,
      marginCents: chargeCents - costCents,
      revenueLines: charge?.lines ?? [],
      positions: positionRows,
    };
  }),

  create: authed.input(CreateInput).handler(async ({ input }) => {
    const [row] = await db
      .insert(customers)
      .values({
        name: input.name,
        kind: input.kind ?? "customer_business",
        status: input.status ?? "active",
        tags: input.tags ?? [],
        notes: input.notes ?? null,
        address: input.address ?? null,
        customerNumber: input.customerNumber ?? null,
        billingEmail: input.billingEmail ?? null,
        billingAddress: input.billingAddress ?? null,
        vatId: input.vatId ?? null,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
      })
      .returning();
    return row!;
  }),

  update: authed.input(UpdateInput).handler(async ({ input }) => {
    const patch: Partial<typeof customers.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.kind !== undefined) patch.kind = input.kind;
    if (input.status !== undefined) patch.status = input.status;
    if (input.tags !== undefined) patch.tags = input.tags;
    if (input.notes !== undefined) patch.notes = input.notes;
    if (input.address !== undefined) patch.address = input.address;
    if (input.customerNumber !== undefined) patch.customerNumber = input.customerNumber;
    if (input.billingEmail !== undefined) patch.billingEmail = input.billingEmail;
    if (input.billingAddress !== undefined) patch.billingAddress = input.billingAddress;
    if (input.vatId !== undefined) patch.vatId = input.vatId;
    if (input.latitude !== undefined) patch.latitude = input.latitude;
    if (input.longitude !== undefined) patch.longitude = input.longitude;

    const [row] = await db
      .update(customers)
      .set(patch)
      .where(eq(customers.id, input.id))
      .returning();
    if (!row) throw new ORPCError("NOT_FOUND", { message: "Kunde nicht gefunden" });
    return row;
  }),

  remove: authed.input(v.object({ id: v.string() })).handler(async ({ input }) => {
    // Invoices are bookkeeping records and pin their customer: the recipient of a
    // document must stay resolvable. Everything else (assets) is set null by the FK.
    const [invoiced] = await db
      .select({ number: invoices.number })
      .from(invoices)
      .where(eq(invoices.customerId, input.id))
      .limit(1);
    if (invoiced) {
      throw new ORPCError("BAD_REQUEST", {
        message: `Kunde hat Rechnungen (${invoiced.number}) und lässt sich nicht löschen`,
      });
    }
    await db.delete(customers).where(eq(customers.id, input.id));
    return { ok: true };
  }),

  contacts: {
    list: authed.input(v.object({ customerId: v.string() })).handler(async ({ input }) => {
      return db
        .select()
        .from(customerContacts)
        .where(eq(customerContacts.customerId, input.customerId))
        .orderBy(asc(customerContacts.name));
    }),

    upsert: authed.input(ContactInput).handler(async ({ input }) => {
      if (input.id) {
        const [row] = await db
          .update(customerContacts)
          .set({
            name: input.name,
            email: input.email ?? null,
            phone: input.phone ?? null,
            role: input.role ?? null,
            isPrimary: input.isPrimary ?? false,
          })
          .where(eq(customerContacts.id, input.id))
          .returning();
        if (!row) throw new ORPCError("NOT_FOUND", { message: "Kontakt nicht gefunden" });
        return row;
      }
      const [row] = await db
        .insert(customerContacts)
        .values({
          customerId: input.customerId,
          name: input.name,
          email: input.email ?? null,
          phone: input.phone ?? null,
          role: input.role ?? null,
          isPrimary: input.isPrimary ?? false,
        })
        .returning();
      return row!;
    }),

    remove: authed.input(v.object({ id: v.string() })).handler(async ({ input }) => {
      await db.delete(customerContacts).where(eq(customerContacts.id, input.id));
      return { ok: true };
    }),
  },

  // Bulk assign (or clear) the location for many assets at once. Works for any
  // asset, including custom-app assets, since it only touches customer_id and
  // never goes through the connector-guarded asset update path.
  assignAssets: authed
    .input(
      v.object({
        customerId: v.nullable(v.string()),
        assetIds: v.pipe(v.array(v.string()), v.minLength(1)),
      }),
    )
    .handler(async ({ input }) => {
      if (input.customerId) {
        const [loc] = await db
          .select({ id: customers.id })
          .from(customers)
          .where(eq(customers.id, input.customerId));
        if (!loc) throw new ORPCError("NOT_FOUND", { message: "Kunde nicht gefunden" });
      }
      await db
        .update(assets)
        .set({ customerId: input.customerId })
        .where(inArray(assets.id, input.assetIds));
      return { ok: true, count: input.assetIds.length };
    }),
};
