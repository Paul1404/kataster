// Ranking for the command palette. Pure so the ordering rules stay testable:
// the router only fetches candidate rows and hands them here.

export interface Rankable {
  name: string;
  externalId?: string | null;
}

/**
 * Score one candidate against a lowercased query. Higher is better, 0 means no
 * match. An exact name beats a name prefix, which beats a name substring, which
 * beats anything matched only through the external id.
 */
export function scoreMatch(query: string, candidate: Rankable): number {
  const term = query.trim().toLowerCase();
  if (!term) return 0;
  const name = candidate.name.toLowerCase();
  const externalId = (candidate.externalId ?? "").toLowerCase();

  if (name === term) return 100;
  if (name.startsWith(term)) return 80;
  if (name.includes(term)) return 60;
  if (externalId === term) return 50;
  if (externalId.startsWith(term)) return 40;
  if (externalId.includes(term)) return 20;
  return 0;
}

/**
 * The best `limit` matches for a query, ordered by score, then by how much of
 * the name the query covers (shorter names first), then alphabetically.
 */
export function rankMatches<T extends Rankable>(query: string, items: T[], limit: number): T[] {
  return items
    .map((item) => ({ item, score: scoreMatch(query, item) }))
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.item.name.length - b.item.name.length ||
        a.item.name.localeCompare(b.item.name),
    )
    .slice(0, limit)
    .map((entry) => entry.item);
}
