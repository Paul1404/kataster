import { ORPCError } from "@orpc/server";
import { and, asc, eq, gt, gte, inArray, isNotNull, lte } from "drizzle-orm";
import * as v from "valibot";
import { db } from "../../db";
import { assets } from "../../db/schema/assets";
import { customers } from "../../db/schema/customers";
import { mailboxes, mailDomains } from "../../db/schema/mail";
import { mailEvents } from "../../db/schema/mail-events";
import { resources } from "../../db/schema/resources";
import { mailEdgeId } from "../../mail/edge";
import { assignOwnerWithHistory } from "../../resources/history";
import { authed } from "../base";

const RECENT_DEFAULT_LIMIT = 500;
const RECENT_MAX_LIMIT = 2000;
const RANGE_MAX_LIMIT = 5000;

// Columns needed to render a particle + feed row. Endpoints are stored resolved.
const eventColumns = {
  id: mailEvents.id,
  direction: mailEvents.direction,
  serverCustomerId: mailEvents.serverCustomerId,
  endpointCustomerId: mailEvents.endpointCustomerId,
  domainName: mailEvents.domainName,
  sender: mailEvents.sender,
  recipient: mailEvents.recipient,
  action: mailEvents.action,
  occurredAt: mailEvents.occurredAt,
};

type EventRow = {
  id: string;
  direction: "inbound" | "outbound";
  serverCustomerId: string | null;
  endpointCustomerId: string | null;
  domainName: string;
  sender: string | null;
  recipient: string | null;
  action: string | null;
  occurredAt: Date;
};

// from/to are derived per direction so the client renders without branching:
// outbound flows customer -> server, inbound flows server -> customer.
function toEventDto(row: EventRow) {
  const outbound = row.direction === "outbound";
  const server = row.serverCustomerId!;
  const customer = row.endpointCustomerId!;
  return {
    id: row.id,
    occurredAt: row.occurredAt,
    direction: row.direction,
    fromCustomerId: outbound ? customer : server,
    toCustomerId: outbound ? server : customer,
    edgeId: mailEdgeId(server, customer),
    domain: row.domainName,
    counterparty: outbound ? row.recipient : row.sender,
    action: row.action,
  };
}

// Only events on a drawable edge (both endpoints placed) can animate.
const onEdge = and(
  isNotNull(mailEvents.serverCustomerId),
  isNotNull(mailEvents.endpointCustomerId),
);

async function assertLocation(customerId: string | null) {
  if (!customerId) return;
  const [loc] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.id, customerId));
  if (!loc) throw new ORPCError("NOT_FOUND", { message: "Kunde nicht gefunden" });
}

/**
 * Mirror a mail assignment onto the Configuration Items, audited. `resources` is
 * the single source of truth for ownership, so assigning on the mail pages has to
 * reach it; the mailcow sync only ever seeds an owner, it never overwrites one.
 */
async function assignMailCIs(input: {
  addresses?: string[];
  domainNames?: string[];
  customerId: string | null;
  actor: string;
}): Promise<void> {
  const ids: string[] = [];
  if (input.addresses?.length) {
    const rows = await db
      .select({ id: resources.id })
      .from(resources)
      .where(and(eq(resources.type, "mailbox"), inArray(resources.externalId, input.addresses)));
    ids.push(...rows.map((r) => r.id));
  }
  if (input.domainNames?.length) {
    // Domain CIs are keyed by the registrable name, lower-cased and www-folded.
    const names = [
      ...new Set(
        input.domainNames.map((n) =>
          n
            .trim()
            .toLowerCase()
            .replace(/^www\./, ""),
        ),
      ),
    ];
    const rows = await db
      .select({ id: resources.id })
      .from(resources)
      .where(and(eq(resources.type, "domain"), inArray(resources.externalId, names)));
    ids.push(...rows.map((r) => r.id));
  }
  if (ids.length === 0) return;
  await assignOwnerWithHistory({
    resourceIds: ids,
    customerId: input.customerId,
    actor: input.actor,
  });
}

export const mailRouter = {
  domains: {
    list: authed.handler(async () => {
      return db
        .select({
          id: mailDomains.id,
          assetId: mailDomains.assetId,
          name: mailDomains.name,
          customerId: mailDomains.customerId,
          active: mailDomains.active,
          mailboxCount: mailDomains.mailboxCount,
          aliasCount: mailDomains.aliasCount,
          storageBytes: mailDomains.storageBytes,
          serverName: assets.name,
          locationName: customers.name,
        })
        .from(mailDomains)
        .leftJoin(assets, eq(mailDomains.assetId, assets.id))
        .leftJoin(customers, eq(mailDomains.customerId, customers.id))
        .orderBy(assets.name, mailDomains.name);
    }),

    assign: authed
      .input(
        v.object({
          domainIds: v.pipe(v.array(v.string()), v.minLength(1)),
          customerId: v.nullable(v.string()),
          includeMailboxes: v.optional(v.boolean()),
        }),
      )
      .handler(async ({ input, context }) => {
        await assertLocation(input.customerId);
        const actor = `user:${context.user.email ?? context.user.id}`;
        const selected = await db
          .select({ assetId: mailDomains.assetId, name: mailDomains.name })
          .from(mailDomains)
          .where(inArray(mailDomains.id, input.domainIds));
        await db
          .update(mailDomains)
          .set({ customerId: input.customerId })
          .where(inArray(mailDomains.id, input.domainIds));
        await assignMailCIs({
          domainNames: selected.map((d) => d.name),
          customerId: input.customerId,
          actor,
        });

        if (input.includeMailboxes) {
          for (const d of selected) {
            const affected = await db
              .select({ address: mailboxes.address })
              .from(mailboxes)
              .where(and(eq(mailboxes.assetId, d.assetId), eq(mailboxes.domainName, d.name)));
            await db
              .update(mailboxes)
              .set({ customerId: input.customerId })
              .where(and(eq(mailboxes.assetId, d.assetId), eq(mailboxes.domainName, d.name)));
            await assignMailCIs({
              addresses: affected.map((m) => m.address),
              customerId: input.customerId,
              actor,
            });
          }
        }
        return { ok: true, count: input.domainIds.length };
      }),
  },

  mailboxes: {
    list: authed
      .input(
        v.optional(
          v.object({
            assetId: v.optional(v.string()),
            domainName: v.optional(v.string()),
          }),
        ),
      )
      .handler(async ({ input }) => {
        const filters = [];
        if (input?.assetId) filters.push(eq(mailboxes.assetId, input.assetId));
        if (input?.domainName) filters.push(eq(mailboxes.domainName, input.domainName));
        return db
          .select({
            id: mailboxes.id,
            assetId: mailboxes.assetId,
            domainName: mailboxes.domainName,
            address: mailboxes.address,
            name: mailboxes.name,
            customerId: mailboxes.customerId,
            active: mailboxes.active,
            quotaUsedBytes: mailboxes.quotaUsedBytes,
            locationName: customers.name,
          })
          .from(mailboxes)
          .leftJoin(customers, eq(mailboxes.customerId, customers.id))
          .where(filters.length > 0 ? and(...filters) : undefined)
          .orderBy(mailboxes.address);
      }),

    assign: authed
      .input(
        v.object({
          mailboxIds: v.pipe(v.array(v.string()), v.minLength(1)),
          customerId: v.nullable(v.string()),
        }),
      )
      .handler(async ({ input, context }) => {
        await assertLocation(input.customerId);
        const affected = await db
          .select({ address: mailboxes.address })
          .from(mailboxes)
          .where(inArray(mailboxes.id, input.mailboxIds));
        await db
          .update(mailboxes)
          .set({ customerId: input.customerId })
          .where(inArray(mailboxes.id, input.mailboxIds));
        await assignMailCIs({
          addresses: affected.map((m) => m.address),
          customerId: input.customerId,
          actor: `user:${context.user.email ?? context.user.id}`,
        });
        return { ok: true, count: input.mailboxIds.length };
      }),
  },

  events: {
    // Live tail: events newer than `since` (default last 60s), oldest first. The
    // returned serverTime lets the client correct for mailcow/app clock skew.
    recent: authed
      .input(
        v.optional(
          v.object({
            since: v.optional(v.string()),
            limit: v.optional(v.pipe(v.number(), v.minValue(1), v.maxValue(RECENT_MAX_LIMIT))),
          }),
        ),
      )
      .handler(async ({ input }) => {
        // Tail by ingestedAt (the app's own clock) so a mail that happened in the
        // past but was only just polled in still reaches the client. serverTime is
        // the cursor the client passes back next poll.
        const since = input?.since ? new Date(input.since) : new Date(Date.now() - 60_000);
        const rows = await db
          .select(eventColumns)
          .from(mailEvents)
          .where(and(onEdge, gt(mailEvents.ingestedAt, since)))
          .orderBy(asc(mailEvents.ingestedAt))
          .limit(input?.limit ?? RECENT_DEFAULT_LIMIT);
        return { events: rows.map(toEventDto), serverTime: new Date() };
      }),

    // Replay: events in a time window, oldest first. `truncated` flags when the
    // window held more than the cap (never silently dropped).
    range: authed
      .input(
        v.object({
          from: v.string(),
          to: v.string(),
          limit: v.optional(v.pipe(v.number(), v.minValue(1), v.maxValue(RANGE_MAX_LIMIT))),
        }),
      )
      .handler(async ({ input }) => {
        const from = new Date(input.from);
        const to = new Date(input.to);
        if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
          throw new ORPCError("VALIDATION_FAILED", { message: "Ungültiger Zeitraum" });
        }
        const limit = input.limit ?? RANGE_MAX_LIMIT;
        const rows = await db
          .select(eventColumns)
          .from(mailEvents)
          .where(and(onEdge, gte(mailEvents.occurredAt, from), lte(mailEvents.occurredAt, to)))
          .orderBy(asc(mailEvents.occurredAt))
          .limit(limit + 1);
        const truncated = rows.length > limit;
        return { events: rows.slice(0, limit).map(toEventDto), truncated };
      }),
  },
};
