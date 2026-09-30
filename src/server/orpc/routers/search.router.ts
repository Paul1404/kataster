import { and, eq, ilike, or } from "drizzle-orm";
import * as v from "valibot";
import { db } from "../../db";
import { assets } from "../../db/schema/assets";
import { customers } from "../../db/schema/customers";
import { resources } from "../../db/schema/resources";
import { rankMatches } from "../../search/rank";
import { authed } from "../base";

// Candidates fetched per group before ranking, and how many survive it. Keeping
// both small keeps the palette a single cheap round trip per keystroke burst.
const CANDIDATE_LIMIT = 60;
const CUSTOMER_RESULTS = 5;
const RESOURCE_RESULTS = 8;
const ASSET_RESULTS = 5;

export interface PaletteHit {
  id: string;
  name: string;
  externalId: string | null;
  /** Resource type key, or null for customers and checks. */
  type: string | null;
  /** Owning customer, when the record has one. */
  ownerName: string | null;
}

export const searchRouter = {
  /**
   * One round trip for the command palette: customers, Configuration Items and
   * monitored checks matching a term by name or external id, each group capped.
   * Only active CIs, like every other list in the app.
   */
  palette: authed
    .input(v.object({ query: v.pipe(v.string(), v.maxLength(200)) }))
    .handler(async ({ input }) => {
      const term = input.query.trim();
      if (term.length < 2) {
        return { query: term, customers: [], resources: [], assets: [] };
      }
      const like = `%${term}%`;

      const [customerRows, resourceRows, assetRows] = await Promise.all([
        db
          .select({ id: customers.id, name: customers.name, externalId: customers.customerNumber })
          .from(customers)
          .where(or(ilike(customers.name, like), ilike(customers.customerNumber, like)))
          .limit(CANDIDATE_LIMIT),
        db
          .select({
            id: resources.id,
            name: resources.name,
            externalId: resources.externalId,
            type: resources.type,
            ownerName: customers.name,
          })
          .from(resources)
          .leftJoin(customers, eq(resources.ownerCustomerId, customers.id))
          .where(
            and(
              eq(resources.status, "active"),
              or(ilike(resources.name, like), ilike(resources.externalId, like)),
            ),
          )
          .limit(CANDIDATE_LIMIT),
        db
          .select({
            id: assets.id,
            name: assets.name,
            externalId: assets.target,
            ownerName: customers.name,
          })
          .from(assets)
          .leftJoin(customers, eq(assets.customerId, customers.id))
          .where(or(ilike(assets.name, like), ilike(assets.target, like)))
          .limit(CANDIDATE_LIMIT),
      ]);

      return {
        query: term,
        customers: rankMatches(term, customerRows, CUSTOMER_RESULTS).map(
          (c): PaletteHit => ({
            id: c.id,
            name: c.name,
            externalId: c.externalId,
            type: null,
            ownerName: null,
          }),
        ),
        resources: rankMatches(term, resourceRows, RESOURCE_RESULTS).map(
          (r): PaletteHit => ({
            id: r.id,
            name: r.name,
            externalId: r.externalId,
            type: r.type,
            ownerName: r.ownerName,
          }),
        ),
        assets: rankMatches(term, assetRows, ASSET_RESULTS).map(
          (a): PaletteHit => ({
            id: a.id,
            name: a.name,
            externalId: a.externalId,
            type: null,
            ownerName: a.ownerName,
          }),
        ),
      };
    }),
};
