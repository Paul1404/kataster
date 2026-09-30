import { MapPin } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useMap } from "react-leaflet";
import { connectorIconById } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { CheckStatus } from "@/server/connectors/types";
import { CapabilityDots } from "./capability-dots";
import { type LabelInput, placeLabels } from "./edge-geometry";
import type { MapNode } from "./infra-map";

function hasAnyCapability(node: MapNode): boolean {
  const c = node.capabilities;
  return c.hasDns || c.hasMail || c.hasWeb || c.hasRegistry || c.hasCloudfront;
}

const STATUS_PRIORITY: Record<CheckStatus, number> = {
  down: 400,
  degraded: 300,
  unknown: 100,
  up: 50,
};

// Infer a node's "kind" glyph from the connectors of the assets it holds.
function nodeGlyph(node: MapNode) {
  const counts = new Map<string, number>();
  for (const a of node.assets) counts.set(a.connectorId, (counts.get(a.connectorId) ?? 0) + 1);
  let best: string | null = null;
  let bestN = 0;
  for (const [id, n] of counts) {
    if (n > bestN) {
      best = id;
      bestN = n;
    }
  }
  return best ? connectorIconById(best) : MapPin;
}

// Rough width before the pill has been measured; corrected on first layout.
function estimateSize(node: MapNode): { w: number; h: number } {
  const countWidth = node.assetCount > 1 ? 22 : 0;
  const capWidth = hasAnyCapability(node) ? 78 : 0;
  return { w: node.name.length * 6.6 + 40 + countWidth + capWidth, h: 24 };
}

export function LabelLayer({
  nodes,
  selectedId,
  hoveredId,
  onSelect,
  onHover,
}: {
  nodes: MapNode[];
  selectedId: string | null;
  hoveredId: string | null;
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;
}) {
  const map = useMap();
  const [container] = useState(() => {
    const el = document.createElement("div");
    el.className = "map-label-layer";
    return el;
  });
  // Bumped on map movement to recompute screen positions.
  const [, force] = useState(0);
  const [zooming, setZooming] = useState(false);
  const [sizes, setSizes] = useState<Map<string, { w: number; h: number }>>(new Map());

  useEffect(() => {
    map.getContainer().appendChild(container);
    const rerender = () => force((v) => v + 1);
    const onZoomStart = () => setZooming(true);
    const onZoomEnd = () => {
      setZooming(false);
      rerender();
    };
    map.on("move moveend viewreset resize", rerender);
    map.on("zoomstart", onZoomStart);
    map.on("zoomend", onZoomEnd);
    return () => {
      map.off("move moveend viewreset resize", rerender);
      map.off("zoomstart", onZoomStart);
      map.off("zoomend", onZoomEnd);
      container.remove();
    };
  }, [map, container]);

  useEffect(() => {
    container.classList.toggle("is-zooming", zooming);
  }, [container, zooming]);

  // Measure a rendered pill and cache its real size (handles long names + fonts).
  const measure = (id: string) => (el: HTMLButtonElement | null) => {
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    setSizes((prev) => {
      const cur = prev.get(id);
      if (cur && Math.abs(cur.w - w) < 1 && Math.abs(cur.h - h) < 1) return prev;
      const next = new Map(prev);
      next.set(id, { w, h });
      return next;
    });
  };

  const size = map.getSize();
  const forced = new Set([selectedId, hoveredId].filter(Boolean) as string[]);

  const points = nodes.map((n) => {
    const p = map.latLngToContainerPoint([n.latitude, n.longitude]);
    return { node: n, x: p.x, y: p.y };
  });

  const inputs: LabelInput[] = points.map(({ node, x, y }) => {
    const s = sizes.get(node.id) ?? estimateSize(node);
    let priority = STATUS_PRIORITY[node.status] + Math.min(node.assetCount, 20);
    if (forced.has(node.id)) priority += 10000;
    return { id: node.id, x, y, width: s.w, height: s.h, priority };
  });

  const placed = new Map(
    placeLabels(inputs, { width: size.x, height: size.y }, forced).map((p) => [p.id, p]),
  );

  return createPortal(
    points.map(({ node }) => {
      const pl = placed.get(node.id);
      if (!pl) return null;
      const Glyph = nodeGlyph(node);
      const active = node.id === selectedId || node.id === hoveredId;
      return (
        <button
          key={node.id}
          type="button"
          ref={measure(node.id)}
          className={cn("map-label", active && "map-label-active")}
          data-status={node.status}
          style={{
            left: pl.left,
            top: pl.top,
            opacity: pl.visible ? 1 : 0,
            pointerEvents: pl.visible ? "auto" : "none",
          }}
          onClick={() => onSelect(node.id)}
          onMouseEnter={() => onHover(node.id)}
          onMouseLeave={() => onHover(null)}
        >
          <Glyph className="map-label-glyph" />
          <span className="map-label-name">{node.name}</span>
          {node.assetCount > 1 && <span className="map-label-count">{node.assetCount}</span>}
          {hasAnyCapability(node) && <CapabilityDots capabilities={node.capabilities} size={11} />}
        </button>
      );
    }),
    container,
  );
}
