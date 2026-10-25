import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, pool } from "../src/server/db";
import { customers } from "../src/server/db/schema/customers";
import { mailboxes } from "../src/server/db/schema/mail";
import { resourceHistory, resources } from "../src/server/db/schema/resources";
import { ingestHostSnapshot } from "../src/server/host-inventory/service";
import { checksQueue } from "../src/server/queue/checks.queue";
import { redisConnection } from "../src/server/queue/connection";
import { mailPollQueue } from "../src/server/queue/mail-poll.queue";

const url = new URL(process.env.DATABASE_URL ?? "");
if (url.hostname !== "127.0.0.1" || url.pathname !== "/kataster_runtime_test")
  throw new Error("Host inventory smoke test requires isolated CI database");
try {
  const [customer] = await db
    .insert(customers)
    .values({ name: "Example owner", kind: "customer_business" })
    .returning();
  const [mailbox] = await db
    .insert(resources)
    .values({
      provider: "mailcow",
      type: "mailbox",
      externalId: "user@example.test",
      name: "Original mailbox",
      ownerCustomerId: customer!.id,
    })
    .returning();
  const observed = new Date();
  const snapshot = {
    hostname: "host.example.test",
    observedAt: observed.toISOString(),
    os: "Rocky Linux",
    mailboxes: [{ address: "user@example.test", name: "Example user", usedBytes: 100 }],
    containers: [{ name: "site-db", site: "site", state: "running", image: "sha256:fixture" }],
    backup: {
      lastSuccessAt: observed.toISOString(),
      snapshotId: "12345678",
      accountCount: 1,
      packedBytes: 500,
    },
    hostMonthlyCents: 1000,
    backupMonthlyCents: 10,
  };
  const first = await ingestHostSnapshot(snapshot, "test");
  const [adopted] = await db.select().from(resources).where(eq(resources.id, mailbox!.id));
  assert.equal(adopted!.provider, "stalwart");
  assert.equal(adopted!.ownerCustomerId, customer!.id);
  assert.equal(adopted!.parentResourceId, first.hostId);
  await assert.rejects(() => ingestHostSnapshot(snapshot, "test"), /bereits verarbeitet/);
  await ingestHostSnapshot(
    {
      ...snapshot,
      observedAt: new Date(observed.getTime() + 1).toISOString(),
      containers: [],
      mailboxes: [],
    },
    "test",
  );
  const [retired] = await db.select().from(resources).where(eq(resources.id, mailbox!.id));
  assert.equal(retired!.status, "decommissioned");
  assert.equal(retired!.ownerCustomerId, customer!.id);
  const typed = await db.select().from(mailboxes).where(eq(mailboxes.address, "user@example.test"));
  assert.equal(typed[0]!.active, false);
  const history = await db
    .select()
    .from(resourceHistory)
    .where(eq(resourceHistory.resourceId, mailbox!.id));
  assert.ok(history.some((h) => h.field === "provider"));
  assert.ok(history.some((h) => h.field === "status"));
  console.log(
    "Host reconciliation passed: stable IDs, preserved owners, replay rejection, audited retirement and mailbox projection",
  );
} finally {
  await Promise.all([checksQueue.close(), mailPollQueue.close()]);
  await redisConnection.quit();
  await pool.end();
}
