// Pure geometry helpers for the infra map: curved/fanned edges and label collision.
// Kept free of Leaflet/DOM so they can be unit-tested in a node environment.

export type LatLng = [number, number];

export interface EdgeEndpoints {
  id: string;
  from: string;
  to: string;
}

/**
 * Sample a quadratic bezier between `a` and `b`. The control point is the chord
 * midpoint pushed perpendicular by `offset * |chord|`, so the line bows out into a
 * gentle arc instead of running straight. `offset` of 0 returns the straight segment.
 *
 * Coordinates are treated as [lat, lng] = [y, x]; this is an approximation in
 * geographic space but reads cleanly at the zoom levels the map uses.
 */
export function quadraticArc(a: LatLng, b: LatLng, offset: number, samples = 24): LatLng[] {
  if (offset === 0) return [a, b];
  const [ay, ax] = a;
  const [by, bx] = b;
  const dx = bx - ax;
  const dy = by - ay;
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  // Perpendicular to the chord, scaled by offset (already proportional to chord length).
  const cx = mx - dy * offset;
  const cy = my + dx * offset;

  const points: LatLng[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const mt = 1 - t;
    const x = mt * mt * ax + 2 * mt * t * cx + t * t * bx;
    const y = mt * mt * ay + 2 * mt * t * cy + t * t * by;
    points.push([y, x]);
  }
  return points;
}

/**
 * Assign a curvature offset to every edge so that multiple edges between the same
 * pair of nodes fan out instead of stacking on top of one another. Edges are grouped
 * by unordered node pair; a lone edge gets a gentle default bow, and groups fan
 * symmetrically around that bow. Reverse-direction edges (A→B vs B→A) naturally curve
 * to opposite sides because the perpendicular flips with the chord direction.
 */
export function assignEdgeOffsets<E extends EdgeEndpoints>(edges: E[]): Map<string, number> {
  const BASE = 0.14;
  const STEP = 0.16;

  const groups = new Map<string, E[]>();
  for (const e of edges) {
    const key = e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`;
    const arr = groups.get(key);
    if (arr) arr.push(e);
    else groups.set(key, [e]);
  }

  const result = new Map<string, number>();
  for (const arr of groups.values()) {
    const n = arr.length;
    arr.forEach((e, i) => {
      const spread = i - (n - 1) / 2;
      result.set(e.id, BASE + spread * STEP);
    });
  }
  return result;
}

export interface LabelInput {
  id: string;
  /** Anchor point in container pixels (the node dot). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Higher priority labels are placed first and win collisions. */
  priority: number;
}

export interface PlacedLabel {
  id: string;
  left: number;
  top: number;
  anchor: "right" | "left" | "top" | "bottom";
  visible: boolean;
}

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function intersects(a: Rect, b: Rect): boolean {
  return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
}

/**
 * Greedy screen-space label placement. Labels are placed highest-priority first; each
 * tries to sit to the right/left/top/bottom of its dot and takes the first slot that
 * neither overlaps an already-placed label nor leaves the viewport. Labels in `forced`
 * (selected/hovered) always render even if they have to overlap; everything else that
 * can't find a clear slot is hidden.
 */
export function placeLabels(
  labels: LabelInput[],
  viewport: { width: number; height: number },
  forced: Set<string> = new Set(),
): PlacedLabel[] {
  const GAP = 9;
  const sorted = [...labels].sort((a, b) => b.priority - a.priority);
  const placed: Rect[] = [];
  const out: PlacedLabel[] = [];

  const candidatesFor = (l: LabelInput) => {
    const half = l.height / 2;
    return [
      { anchor: "right" as const, left: l.x + GAP, top: l.y - half },
      { anchor: "left" as const, left: l.x - GAP - l.width, top: l.y - half },
      { anchor: "top" as const, left: l.x - l.width / 2, top: l.y - GAP - l.height },
      { anchor: "bottom" as const, left: l.x - l.width / 2, top: l.y + GAP },
    ];
  };

  for (const l of sorted) {
    let chosen: PlacedLabel | null = null;
    for (const c of candidatesFor(l)) {
      const rect: Rect = {
        left: c.left,
        top: c.top,
        right: c.left + l.width,
        bottom: c.top + l.height,
      };
      const inView =
        rect.left >= 0 &&
        rect.top >= 0 &&
        rect.right <= viewport.width &&
        rect.bottom <= viewport.height;
      if (inView && !placed.some((p) => intersects(rect, p))) {
        placed.push(rect);
        chosen = { id: l.id, left: c.left, top: c.top, anchor: c.anchor, visible: true };
        break;
      }
    }

    if (!chosen) {
      const first = candidatesFor(l)[0]!;
      if (forced.has(l.id)) {
        placed.push({
          left: first.left,
          top: first.top,
          right: first.left + l.width,
          bottom: first.top + l.height,
        });
        chosen = {
          id: l.id,
          left: first.left,
          top: first.top,
          anchor: first.anchor,
          visible: true,
        };
      } else {
        chosen = {
          id: l.id,
          left: first.left,
          top: first.top,
          anchor: first.anchor,
          visible: false,
        };
      }
    }
    out.push(chosen);
  }

  return out;
}
