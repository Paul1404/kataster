import {
  Activity,
  Cloud,
  Globe,
  type LucideIcon,
  Mail,
  Network,
  Newspaper,
  Plug,
  Server,
  TrainFront,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  Globe,
  Network,
  Mail,
  Newspaper,
  Activity,
  Cloud,
  Server,
  Train: TrainFront,
};

/** Resolve a connector's lucide icon name to a component, with a safe fallback. */
export function connectorIcon(name: string): LucideIcon {
  return ICONS[name] ?? Plug;
}

// Registry connector id -> lucide icon name (mirrors src/server/connectors/registry.ts).
const CONNECTOR_ICON_BY_ID: Record<string, string> = {
  http: "Globe",
  aws: "Cloud",
  mailcow: "Mail",
  wordpress: "Newspaper",
  checkmk: "Activity",
  hetzner: "Server",
  railway: "Train",
};

/** Resolve a connector id directly to its lucide icon component. */
export function connectorIconById(connectorId: string): LucideIcon {
  return connectorIcon(CONNECTOR_ICON_BY_ID[connectorId] ?? "Plug");
}
