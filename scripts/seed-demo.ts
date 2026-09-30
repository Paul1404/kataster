/** Fictional portfolio data. Refuses remote databases and nonempty registers. */
import { sql } from "drizzle-orm";
import { db, pool } from "../src/server/db";
import {
  assets,
  contractPositions,
  costAllocations,
  customers,
  providerCosts,
  resources,
} from "../src/server/db/schema";
import { recordResourceHistory } from "../src/server/resources/history";

async function main() {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !url.pathname.startsWith("/kataster_demo_") ||
    process.env.NODE_ENV === "production"
  ) {
    throw new Error("Use an isolated local database named kataster_demo_*. No production seeding.");
  }
  const period = new Date().toISOString().slice(0, 7);
  await db.transaction(async (tx) => {
    const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(customers);
    if (count) throw new Error("The demo register must be empty.");
    const names = [
      "Kulturhaus Musterstadt",
      "Sportverein Beispielhausen",
      "Atelier Morgenrot",
      "Gemeindewerk Beispielstadt",
      "Büro Nordlicht",
      "Werkstatt Lindenhof",
      "Bildungsverein Musterberg",
      "Praxis Sonnenplatz",
    ];
    const [poolCost] = await tx
      .insert(providerCosts)
      .values({
        provider: "other",
        period,
        label: "Demo-Infrastruktur",
        amountCents: 28400,
      })
      .returning();
    for (const [i, name] of names.entries()) {
      const [customer] = await tx
        .insert(customers)
        .values({
          name,
          customerNumber: `DEMO-${String(i + 1).padStart(3, "0")}`,
          billingEmail: `office@customer-${i + 1}.example.test`,
          billingAddress: `Beispielstraße ${i + 1}, 00000 Musterstadt`,
          tags: ["Demo", i % 2 ? "Gewerbe" : "Verein"],
        })
        .returning();
      const types = ["domain", "mail_domain", "container", "mailbox"] as const;
      for (const [j, type] of types.entries()) {
        const domain = `customer-${i + 1}.example.test`;
        const [resource] = await tx
          .insert(resources)
          .values({
            type,
            provider: "other",
            externalId: `demo:${i}:${type}`,
            name: type === "mailbox" ? `office@${domain}` : j === 2 ? `${name} / Website` : domain,
            ownerCustomerId: customer.id,
            metadata: type === "domain" ? { registryExpiresAt: "2027-09-30T00:00:00Z" } : {},
          })
          .returning();
        await tx.insert(costAllocations).values({
          resourceId: resource.id,
          period,
          mode: "weighted",
          weight: 1 / (names.length * types.length),
          providerCostId: poolCost.id,
        });
        await recordResourceHistory(
          [{ resourceId: resource.id, field: "owner", oldValue: null, newValue: name }],
          "demo",
          tx,
        );
        if (j === 2)
          await tx.insert(assets).values({
            name: `${name} / Website`,
            connectorId: "http",
            target: `https://${domain}`,
            customerId: customer.id,
            resourceId: resource.id,
            enabled: true,
            lastStatus: "up",
            lastLatencyMs: 80 + i * 17,
            lastCheckedAt: new Date(),
            tags: ["Demo"],
          });
      }
      await tx.insert(contractPositions).values({
        customerId: customer.id,
        label: "Webhosting und Mailbetrieb",
        quantity: 1,
        unitPriceCents: 7900 + i * 500,
        startsPeriod: period,
      });
    }
  });
  console.info(
    "Created 8 fictional customers and 32 resources. Do not start a worker for this demo.",
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Demo seeding failed.");
    process.exitCode = 1;
  })
  .finally(() => pool.end());
