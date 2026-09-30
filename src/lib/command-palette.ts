// Pure result assembly for the command palette. The component only renders what
// this returns, so grouping, labelling and the keyboard order are testable.

import { resourceTypeLabel } from "./format";

/** Every page the palette can jump to. `to` stays a literal for typed routing. */
export const PALETTE_PAGES = [
  { to: "/dashboard", label: "Übersicht" },
  { to: "/objects", label: "Objekte" },
  { to: "/customers", label: "Kunden" },
  { to: "/billing", label: "Abrechnung" },
  { to: "/costs", label: "Kosten" },
  { to: "/domains", label: "Mail-Domains" },
  { to: "/assets", label: "Prüfungen" },
  { to: "/hosts", label: "Hosts" },
  { to: "/ci", label: "Domains" },
  { to: "/connections", label: "Verbindungen" },
  { to: "/settings", label: "Einstellungen" },
] as const;

export type PalettePage = (typeof PALETTE_PAGES)[number];

export type PaletteKind = "page" | "customer" | "resource" | "asset";

export interface PaletteRow {
  /** Stable key: the route path for pages, the record id otherwise. */
  id: string;
  kind: PaletteKind;
  label: string;
  /** Type of the record, e.g. "Kunde", "Host", "Prüfung". */
  typeLabel: string;
  /** Owner or external id, whichever helps telling two rows apart. */
  sublabel: string | null;
}

export interface PaletteGroup {
  key: string;
  label: string;
  rows: PaletteRow[];
}

export interface PaletteHitInput {
  id: string;
  name: string;
  externalId: string | null;
  type: string | null;
  ownerName: string | null;
}

export interface PaletteData {
  customers: PaletteHitInput[];
  resources: PaletteHitInput[];
  assets: PaletteHitInput[];
}

export const EMPTY_PALETTE_DATA: PaletteData = { customers: [], resources: [], assets: [] };

/** Static pages whose label contains the query. An empty query offers them all. */
export function matchPages(query: string): PalettePage[] {
  const term = query.trim().toLowerCase();
  if (!term) return [...PALETTE_PAGES];
  return PALETTE_PAGES.filter((p) => p.label.toLowerCase().includes(term));
}

/**
 * Records first, then pages: when someone types a customer name the record they
 * mean should be the row Enter picks.
 */
export function buildGroups(query: string, data: PaletteData): PaletteGroup[] {
  const groups: PaletteGroup[] = [];

  if (data.customers.length > 0) {
    groups.push({
      key: "customers",
      label: "Kunden",
      rows: data.customers.map((c) => ({
        id: c.id,
        kind: "customer",
        label: c.name,
        typeLabel: "Kunde",
        sublabel: c.externalId,
      })),
    });
  }

  if (data.resources.length > 0) {
    groups.push({
      key: "resources",
      label: "Objekte",
      rows: data.resources.map((r) => ({
        id: r.id,
        kind: "resource",
        label: r.name,
        typeLabel: r.type ? resourceTypeLabel(r.type) : "Objekt",
        sublabel: r.ownerName ?? r.externalId,
      })),
    });
  }

  if (data.assets.length > 0) {
    groups.push({
      key: "assets",
      label: "Prüfungen",
      rows: data.assets.map((a) => ({
        id: a.id,
        kind: "asset",
        label: a.name,
        typeLabel: "Prüfung",
        sublabel: a.ownerName ?? a.externalId,
      })),
    });
  }

  const pages = matchPages(query);
  if (pages.length > 0) {
    groups.push({
      key: "pages",
      label: "Seiten",
      rows: pages.map((p) => ({
        id: p.to,
        kind: "page",
        label: p.label,
        typeLabel: "Seite",
        sublabel: null,
      })),
    });
  }

  return groups;
}

/** The rows in the order the arrow keys walk them. */
export function flattenGroups(groups: PaletteGroup[]): PaletteRow[] {
  return groups.flatMap((g) => g.rows);
}

/** Wrapping cursor movement over the flattened rows. */
export function moveIndex(current: number, delta: number, length: number): number {
  if (length === 0) return 0;
  return (current + delta + length) % length;
}
