import { AtSign, Cloud, Globe, Network, ShieldCheck } from "lucide-react";
import type { MapCapabilities } from "./infra-map";

// The capabilities a customer can run, in a fixed order, each with a glyph and
// accent colour. Lit when present, faint when absent. `title` is the fuller
// wording used in tooltips and the map legend.
const CAPS = [
  { key: "hasDns", label: "DNS", title: "DNS", Icon: Network, color: "#2f6bff" },
  { key: "hasMail", label: "E-Mail", title: "E-Mail", Icon: AtSign, color: "#14b8c4" },
  { key: "hasWeb", label: "Web", title: "Web", Icon: Globe, color: "#a855f7" },
  {
    key: "hasRegistry",
    label: "Registrar",
    title: "Registrierung",
    Icon: ShieldCheck,
    color: "#f59e0b",
  },
  {
    key: "hasCloudfront",
    label: "CDN",
    title: "Durch CloudFront geschützt",
    Icon: Cloud,
    color: "#34d399",
  },
] as const;

export function CapabilityDots({
  capabilities,
  size = 12,
}: {
  capabilities: MapCapabilities;
  size?: number;
}) {
  return (
    <span className="map-caps" style={{ ["--cap-size" as string]: `${size}px` }}>
      {CAPS.map(({ key, title, Icon, color }) => {
        const on = capabilities[key];
        return (
          <span
            key={key}
            className="map-cap"
            data-on={on ? "true" : "false"}
            style={on ? { color } : undefined}
            title={`${title}: ${on ? "ja" : "nein"}`}
          >
            <Icon style={{ width: "var(--cap-size)", height: "var(--cap-size)" }} />
          </span>
        );
      })}
    </span>
  );
}

export const CAPABILITY_LIST = CAPS;
