import * as v from "valibot";

const text = v.pipe(v.string(), v.minLength(1), v.maxLength(500));
const bytes = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER));
export const Hostname = v.pipe(
  v.string(),
  v.regex(/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?\.[a-z]{2,}$/),
);
export const HostSnapshotSchema = v.strictObject({
  hostname: Hostname,
  observedAt: v.pipe(v.string(), v.isoTimestamp()),
  os: text,
  mailboxes: v.pipe(
    v.array(
      v.strictObject({
        address: v.pipe(v.string(), v.email(), v.maxLength(254)),
        name: text,
        usedBytes: bytes,
      }),
    ),
    v.maxLength(500),
  ),
  containers: v.pipe(
    v.array(
      v.strictObject({
        name: text,
        site: text,
        domain: v.optional(Hostname),
        state: v.picklist(["running", "stopped", "paused", "unknown"]),
        image: text,
      }),
    ),
    v.maxLength(500),
  ),
  backup: v.strictObject({
    lastSuccessAt: v.nullable(v.pipe(v.string(), v.isoTimestamp())),
    snapshotId: v.nullable(v.pipe(v.string(), v.regex(/^[a-f0-9]{8,64}$/))),
    accountCount: bytes,
    packedBytes: bytes,
  }),
  hostMonthlyCents: v.optional(bytes),
  backupMonthlyCents: v.optional(bytes),
});
export type HostSnapshot = v.InferOutput<typeof HostSnapshotSchema>;

export function parseHostSnapshot(input: unknown, now = new Date()): HostSnapshot {
  const snapshot = v.parse(HostSnapshotSchema, input);
  const age = now.getTime() - Date.parse(snapshot.observedAt);
  if (age < -300_000 || age > 1_800_000)
    throw new Error("Hostinventar ist veraltet oder hat eine ungültige Uhrzeit");
  if (
    new Set(snapshot.mailboxes.map((m) => m.address)).size !== snapshot.mailboxes.length ||
    new Set(snapshot.containers.map((c) => `${c.site}/${c.name}`)).size !==
      snapshot.containers.length
  )
    throw new Error("Hostinventar enthält doppelte Objekte");
  return snapshot;
}

export function summarizeHost(snapshot: HostSnapshot, now = new Date()) {
  const stale = now.getTime() - Date.parse(snapshot.observedAt) > 2_700_000;
  const missingCosts = snapshot.hostMonthlyCents == null || snapshot.backupMonthlyCents == null;
  return {
    status: stale ? ("unknown" as const) : missingCosts ? ("degraded" as const) : ("up" as const),
    latencyMs: null,
    message: stale
      ? "Hostinventar seit über 45 Minuten nicht aktualisiert"
      : `${snapshot.mailboxes.length} Stalwart-Postfächer, ${snapshot.containers.length} Container${missingCosts ? "; Contabo-/B2-Kosten noch unvollständig" : ""}`,
    raw: {
      hostname: snapshot.hostname,
      os: snapshot.os,
      observedAt: snapshot.observedAt,
      mailboxes: {
        count: snapshot.mailboxes.length,
        quotaUsedBytes: snapshot.mailboxes.reduce((sum, m) => sum + m.usedBytes, 0),
      },
      domains: { count: new Set(snapshot.mailboxes.map((m) => m.address.split("@")[1])).size },
      containers: {
        count: snapshot.containers.length,
        running: snapshot.containers.filter((c) => c.state === "running").length,
      },
      backup: snapshot.backup,
      missingCosts,
    },
  };
}
