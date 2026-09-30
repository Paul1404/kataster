import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { memo, useEffect, useMemo, useRef } from "react";
import { MapContainer, Marker, Polyline, TileLayer, useMap } from "react-leaflet";
import type { FlowController } from "@/lib/mail-flow";
import type { CheckStatus } from "@/server/connectors/types";
import { assignEdgeOffsets, quadraticArc } from "./edge-geometry";
import { LabelLayer } from "./label-layer";
import ParticleLayer from "./particle-layer";

export interface MapAsset {
  id: string;
  name: string;
  connectorId: string;
  lastStatus: CheckStatus;
  lastLatencyMs: number | null;
}

export interface MapDomain {
  name: string;
  mailboxCount: number;
  active: boolean;
}

export interface MapCapabilities {
  hasDns: boolean;
  hasMail: boolean;
  hasWeb: boolean;
  hasRegistry: boolean;
  hasCloudfront: boolean;
  registryExpiresAt: string | Date | null;
}

export type CustomerKind =
  | "provider"
  | "customer_private"
  | "customer_business"
  | "internal"
  | "partner";

export interface MapNode {
  id: string;
  name: string;
  kind: CustomerKind;
  crmStatus: "active" | "prospect" | "churned";
  latitude: number;
  longitude: number;
  address: string | null;
  assetCount: number;
  resourceCount: number;
  status: CheckStatus;
  assets: MapAsset[];
  domains: MapDomain[];
  domainCount: number;
  mailboxCount: number;
  capabilities: MapCapabilities;
}

export interface MapEdge {
  id: string;
  fromCustomerId: string;
  toCustomerId: string;
  type: string;
  label: string | null;
  kind?: string;
  derived?: boolean;
}

const STATUS_COLOR: Record<CheckStatus, string> = {
  up: "#2f6bff",
  down: "#ef4444",
  degraded: "#f59e0b",
  unknown: "#475569",
};

// divIcon HTML is a string, so the marker colour is injected as a CSS var. Only
// down/degraded nodes pulse; healthy nodes stay calm with a static glow.
function markerIcon(node: MapNode, selected: boolean, active: boolean): L.DivIcon {
  const c = STATUS_COLOR[node.status];
  const animated = node.status === "down" || node.status === "degraded";
  const cls = ["map-marker", animated ? "is-animated" : "", active ? "is-active" : ""]
    .filter(Boolean)
    .join(" ");
  const halo = selected ? '<span class="map-marker-halo"></span>' : "";
  const ring = animated ? '<span class="map-marker-ring"></span>' : "";
  return L.divIcon({
    className: "map-marker-wrap",
    html: `<div class="${cls}" style="--c:${c}">${halo}${ring}<span class="map-marker-dot"></span></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

// Memoized so hovering one node re-renders only the two affected markers (the
// one leaving and the one entering active state), not all pins. onSelect/onHover
// are stable state setters, so the memo compares only node/selected/active.
const NodeMarker = memo(function NodeMarker({
  node,
  selected,
  active,
  onSelect,
  onHover,
}: {
  node: MapNode;
  selected: boolean;
  active: boolean;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
}) {
  const icon = useMemo(() => markerIcon(node, selected, active), [node, selected, active]);
  return (
    <Marker
      position={[node.latitude, node.longitude]}
      icon={icon}
      zIndexOffset={selected ? 1000 : active ? 500 : 0}
      eventHandlers={{
        click: () => onSelect(node.id),
        mouseover: () => onHover(node.id),
        mouseout: () => onHover(null),
      }}
    />
  );
});

// Auto-fit the viewport to all pins, but only when the SET of customers changes
// (not on every status refetch), so it never fights the user's pan/zoom.
function FitBounds({ nodes }: { nodes: MapNode[] }) {
  const map = useMap();
  const lastKey = useRef<string>("");
  useEffect(() => {
    const key = nodes
      .map((n) => n.id)
      .sort()
      .join(",");
    if (key === lastKey.current) return;
    lastKey.current = key;
    if (nodes.length === 0) return;
    if (nodes.length === 1) {
      map.setView([nodes[0]!.latitude, nodes[0]!.longitude], 6);
      return;
    }
    const bounds = L.latLngBounds(nodes.map((n) => [n.latitude, n.longitude] as [number, number]));
    map.fitBounds(bounds, { padding: [80, 80], maxZoom: 11 });
  }, [nodes, map]);
  return null;
}

export default function InfraMap({
  nodes,
  edges,
  selectedId,
  hoveredId,
  onSelect,
  onHover,
  flowController,
}: {
  nodes: MapNode[];
  edges: MapEdge[];
  selectedId: string | null;
  hoveredId: string | null;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
  flowController?: FlowController;
}) {
  // byId and offsets depend only on the data, not on hover/select — memoize so a
  // pointer move doesn't rebuild the lookup Map and re-run edge-offset assignment.
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const offsets = useMemo(
    () =>
      assignEdgeOffsets(
        edges.map((e) => ({ id: e.id, from: e.fromCustomerId, to: e.toCustomerId })),
      ),
    [edges],
  );
  const hasActive = selectedId !== null || hoveredId !== null;
  const isActive = (id: string) => id === selectedId || id === hoveredId;

  return (
    <MapContainer
      center={[25, 5]}
      zoom={2}
      minZoom={2}
      maxZoom={19}
      // Fractional zoom: fine-grained wheel + smaller +/- steps so you can settle
      // between the coarse integer levels instead of jumping a whole level.
      zoomSnap={0.25}
      zoomDelta={0.5}
      wheelPxPerZoomLevel={90}
      worldCopyJump
      className="h-full w-full"
      style={{ background: "#07101e" }}
    >
      <TileLayer
        url="https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png"
        subdomains="abcd"
        maxZoom={19}
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
      />
      <TileLayer
        url="https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png"
        subdomains="abcd"
        maxZoom={19}
        opacity={0.5}
      />
      <FitBounds nodes={nodes} />

      {edges.map((e) => {
        const a = byId.get(e.fromCustomerId);
        const b = byId.get(e.toCustomerId);
        if (!a || !b || a.id === b.id) return null;
        const active = isActive(a.id) || isActive(b.id);
        const base = e.kind === "mail" ? "flow-mail" : `flow-${a.status}`;
        const cls = ["flow-line", base, active && "flow-active", hasActive && !active && "flow-dim"]
          .filter(Boolean)
          .join(" ");
        const arc = quadraticArc(
          [a.latitude, a.longitude],
          [b.latitude, b.longitude],
          offsets.get(e.id) ?? 0.14,
        );
        return (
          <Polyline
            key={e.id}
            positions={arc}
            pathOptions={{ className: cls, weight: active ? 2.5 : 1.6 }}
          />
        );
      })}

      {nodes.map((n) => (
        <NodeMarker
          key={n.id}
          node={n}
          selected={selectedId === n.id}
          active={isActive(n.id)}
          onSelect={onSelect}
          onHover={onHover}
        />
      ))}

      {flowController && <ParticleLayer controller={flowController} nodes={nodes} edges={edges} />}

      <LabelLayer
        nodes={nodes}
        selectedId={selectedId}
        hoveredId={hoveredId}
        onSelect={onSelect}
        onHover={onHover}
      />
    </MapContainer>
  );
}
