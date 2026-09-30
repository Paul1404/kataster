import L from "leaflet";
import { useEffect, useMemo, useRef } from "react";
import { useMap } from "react-leaflet";
import { DIRECTION_COLOR, type FlowController } from "@/lib/mail-flow";
import { assignEdgeOffsets, type LatLng, quadraticArc } from "./edge-geometry";
import type { MapEdge, MapNode } from "./infra-map";

// Trail samples behind the head, oldest first; more = longer glowing tail.
const TRAIL = 7;
const TRAIL_STEP = 0.05;

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

interface EdgeGeom {
  /** Sampled arc points from the edge's `from` node to its `to` node. */
  pts: LatLng[];
  /** Normalized cumulative arc length (0..1), one per point. */
  cum: number[];
  fromId: string;
  toId: string;
}

// Position along an arc at parameter t (0..1), measured by arc length.
function pointAt(geom: EdgeGeom, t: number): LatLng {
  const { pts, cum } = geom;
  if (t <= 0) return pts[0]!;
  if (t >= 1) return pts[pts.length - 1]!;
  let i = 1;
  while (i < cum.length && cum[i]! < t) i++;
  const t0 = cum[i - 1]!;
  const t1 = cum[i]!;
  const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
  const [y0, x0] = pts[i - 1]!;
  const [y1, x1] = pts[i]!;
  return [y0 + (y1 - y0) * f, x0 + (x1 - x0) * f];
}

/**
 * A single full-map canvas that draws all in-flight mail particles. Sits above the
 * tile/SVG panes and below markers; one rAF loop reads particle positions fresh each
 * frame from the controller. Particles travel the exact same quadratic arc the edge
 * polyline is drawn on, so packets stay glued to the visible line during pan/zoom.
 * Pure imperative: never triggers a React re-render.
 */
export default function ParticleLayer({
  controller,
  nodes,
  edges,
}: {
  controller: FlowController;
  nodes: MapNode[];
  edges: MapEdge[];
}) {
  const map = useMap();

  // Per-edge arc geometry, identical to what InfraMap renders (same offsets).
  const geom = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const offsets = assignEdgeOffsets(
      edges.map((e) => ({ id: e.id, from: e.fromCustomerId, to: e.toCustomerId })),
    );
    const m = new Map<string, EdgeGeom>();
    for (const e of edges) {
      const a = byId.get(e.fromCustomerId);
      const b = byId.get(e.toCustomerId);
      if (!a || !b || a.id === b.id) continue;
      const pts = quadraticArc(
        [a.latitude, a.longitude],
        [b.latitude, b.longitude],
        offsets.get(e.id) ?? 0.14,
      );
      // Cumulative arc length in lat/lng space, normalized to 0..1.
      const cum = [0];
      let total = 0;
      for (let i = 1; i < pts.length; i++) {
        const [y0, x0] = pts[i - 1]!;
        const [y1, x1] = pts[i]!;
        total += Math.hypot(y1 - y0, x1 - x0);
        cum.push(total);
      }
      for (let i = 0; i < cum.length; i++) cum[i] = total > 0 ? cum[i]! / total : 0;
      m.set(e.id, { pts, cum, fromId: e.fromCustomerId, toId: e.toCustomerId });
    }
    return m;
  }, [nodes, edges]);

  const geomRef = useRef(geom);
  geomRef.current = geom;

  useEffect(() => {
    const canvas = document.createElement("canvas");
    canvas.style.position = "absolute";
    canvas.style.inset = "0";
    canvas.style.pointerEvents = "none";
    canvas.style.zIndex = "450"; // above overlayPane (400), below markerPane (600)
    map.getContainer().appendChild(canvas);

    const ctx = canvas.getContext("2d");
    let zooming = false;
    let raf = 0;

    function resize() {
      const size = map.getSize();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(size.x * dpr);
      canvas.height = Math.round(size.y * dpr);
      canvas.style.width = `${size.x}px`;
      canvas.style.height = `${size.y}px`;
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();

    const onZoomStart = () => {
      zooming = true;
    };
    const onZoomEnd = () => {
      zooming = false;
    };
    map.on("resize", resize);
    map.on("zoomstart", onZoomStart);
    map.on("zoomend", onZoomEnd);

    function frame() {
      raf = requestAnimationFrame(frame);
      if (!ctx) return;
      controller.advance(Date.now());

      const size = map.getSize();
      ctx.clearRect(0, 0, size.x, size.y);
      // Reading projections mid-zoom drifts; skip drawing until the zoom settles.
      if (zooming) return;

      ctx.globalCompositeOperation = "lighter";
      const now = Date.now();
      const geoms = geomRef.current;

      for (const p of controller.particles) {
        const g = geoms.get(p.edgeId);
        if (!g) continue;
        // The arc runs from→to; flip param when the particle travels the other way.
        const reverse = p.fromCustomerId === g.toId;
        const head = easeInOutCubic(Math.min(1, (now - p.startMs) / p.durationMs));
        const color = DIRECTION_COLOR[p.direction];

        for (let i = TRAIL; i >= 0; i--) {
          const local = head - i * TRAIL_STEP;
          if (local < 0) continue;
          const t = reverse ? 1 - local : local;
          const [lat, lng] = pointAt(g, t);
          const pt = map.latLngToContainerPoint(L.latLng(lat, lng));
          const lead = i === 0;
          const alpha = lead ? 0.95 : 0.5 * (1 - i / (TRAIL + 1));
          const r = lead ? 3.2 : 2.2 * (1 - i / (TRAIL + 1));
          if (r <= 0) continue;
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
          ctx.fillStyle = withAlpha(color, alpha);
          ctx.fill();
        }
      }
      ctx.globalCompositeOperation = "source-over";
    }
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      map.off("resize", resize);
      map.off("zoomstart", onZoomStart);
      map.off("zoomend", onZoomEnd);
      canvas.remove();
    };
  }, [map, controller]);

  return null;
}

// #rrggbb -> rgba() with the given alpha.
function withAlpha(hex: string, alpha: number): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
}
