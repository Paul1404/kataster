import { awsConnector } from "./aws/aws.connector";
import { checkmkConnector } from "./checkmk/checkmk.connector";
import { hetznerCloudConnector } from "./hetzner-cloud/hetzner-cloud.connector";
import { httpConnector } from "./http/http.connector";
import { mailcowConnector } from "./mailcow/mailcow.connector";
import { railwayConnector } from "./railway/railway.connector";
import { ssmConnector } from "./ssm/ssm.connector";
import type { AnyConnector } from "./types";
import { wordpressConnector } from "./wordpress/wordpress.connector";

// The single source of truth. Add a connector here and it is automatically
// available to the worker, the API, and the dynamic asset form. Inventory
// providers come first; the generic HTTP/uptime probe is demoted to the end
// since it owns nothing and is now optional.
const connectorList: AnyConnector[] = [
  awsConnector,
  ssmConnector,
  mailcowConnector,
  hetznerCloudConnector,
  railwayConnector,
  wordpressConnector,
  checkmkConnector,
  httpConnector,
];

export const connectorRegistry: Map<string, AnyConnector> = new Map(
  connectorList.map((c) => [c.id, c]),
);

export function getConnector(id: string): AnyConnector | undefined {
  return connectorRegistry.get(id);
}

export function requireConnector(id: string): AnyConnector {
  const connector = connectorRegistry.get(id);
  if (!connector) {
    throw new Error(`Unknown connector: ${id}`);
  }
  return connector;
}

export function listConnectors(): AnyConnector[] {
  return [...connectorRegistry.values()];
}
