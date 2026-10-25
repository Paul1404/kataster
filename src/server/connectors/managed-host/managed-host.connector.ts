import { eq } from "drizzle-orm";
import * as v from "valibot";
import { db } from "../../db";
import { hostInventory } from "../../db/schema/host-inventory";
import { summarizeHost } from "../../host-inventory/schema";
import { defineConnector } from "../define";

export const managedHostConnector = defineConnector({
  id: "managed-host",
  name: "Contabo, Stalwart und GitOps",
  icon: "Server",
  description:
    "Hostinventar mit Stalwart-Postfächern, rootless Containern und verschlüsseltem Backblaze-B2-Backup. Datenstand und fehlende Kosten bleiben sichtbar.",
  kind: "source",
  capabilities: { probe: true, inventory: true },
  configSchema: v.object({}),
  defaultIntervalSeconds: 900,
  setup: {
    steps: [
      "Hostexporter nach docs/host-inventory.md installieren.",
      "Einen auf diesen Host begrenzten Zugang registrieren.",
      "Export alle 15 Minuten aktivieren und den ersten Abgleich prüfen.",
    ],
  },
  async check(target, _config, _secrets, ctx) {
    const row = await db.query.hostInventory.findFirst({
      where: eq(hostInventory.hostname, target),
    });
    return row
      ? summarizeHost(row.payload, ctx.now)
      : {
          status: "unknown",
          latencyMs: null,
          message: "Noch kein Hostinventar empfangen",
          raw: {},
        };
  },
});
