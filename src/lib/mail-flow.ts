// Headless controller for the map's mail-flow particles. It owns a scheduled event
// queue and a live particle pool, advanced once per animation frame by the canvas
// layer. Kept outside React state so 60fps updates never re-render the map tree.
//
// One playhead clock unifies both modes:
//   - live:   playhead = wall clock; a poll's batch is spread over the next window
//             so packets stream out at their real relative spacing.
//   - replay: playhead is a virtual clock swept across a past window at `speed`.

export type MailDirection = "inbound" | "outbound";

export interface FlowEventInput {
  id: string;
  edgeId: string;
  direction: MailDirection;
  fromCustomerId: string;
  toCustomerId: string;
  occurredAt: string | Date;
}

interface ScheduledEvent {
  id: string;
  edgeId: string;
  direction: MailDirection;
  fromCustomerId: string;
  toCustomerId: string;
  /** Controller-clock time at which to spawn this event's particle. */
  playAtMs: number;
}

export interface Particle {
  edgeId: string;
  fromCustomerId: string;
  toCustomerId: string;
  direction: MailDirection;
  startMs: number;
  durationMs: number;
}

export type FlowMode = "live" | "replay";

export const DIRECTION_COLOR: Record<MailDirection, string> = {
  outbound: "#2f6bff", // signal blue: leaving us, toward the server
  inbound: "#14b8c4", // aqua: arriving, server toward customer
};

const MAX_ACTIVE = 300;
const MAX_SPAWN_PER_FRAME = 8;
const PARTICLE_MIN_MS = 1400;
const PARTICLE_MAX_MS = 2200;
const SEEN_CAP = 4000;

function toMs(when: string | Date): number {
  return when instanceof Date ? when.getTime() : Date.parse(when);
}

export class FlowController {
  mode: FlowMode = "live";
  playheadMs = Date.now();
  speed = 1;
  playing = true;
  /** Replay window bounds (ms). Used to clamp the virtual playhead. */
  windowStartMs = 0;
  windowEndMs = 0;
  /** Cumulative count of particles dropped to the per-frame/active cap. */
  overflow = 0;

  readonly particles: Particle[] = [];
  private events: ScheduledEvent[] = [];
  private pointer = 0;
  private seen = new Set<string>();
  private lastScheduledMs = 0;
  private lastRealMs = Date.now();

  /** Switch to live tailing. Clears any replay queue. */
  setLive(): void {
    this.mode = "live";
    this.playing = true;
    this.speed = 1;
    this.events = [];
    this.pointer = 0;
    this.seen.clear();
    this.lastScheduledMs = 0;
    this.particles.length = 0;
  }

  /** Add freshly polled live events, spread across the upcoming window. */
  ingestLive(input: FlowEventInput[], nowMs = Date.now()): void {
    if (this.mode !== "live") return;
    const fresh = input.filter((e) => !this.seen.has(e.id));
    if (fresh.length === 0) return;
    for (const e of fresh) this.seen.add(e.id);
    if (this.seen.size > SEEN_CAP) {
      // Bound memory: forget the oldest ids (overlap re-dedup handled server-side).
      this.seen = new Set(input.map((e) => e.id));
    }

    const occ = fresh.map((e) => toMs(e.occurredAt));
    const firstOcc = Math.min(...occ);
    const base = Math.max(nowMs, this.lastScheduledMs);
    for (let i = 0; i < fresh.length; i++) {
      const playAtMs = base + (occ[i]! - firstOcc);
      this.events.push({ ...fresh[i]!, playAtMs });
      if (playAtMs > this.lastScheduledMs) this.lastScheduledMs = playAtMs;
    }
    this.events.sort((a, b) => a.playAtMs - b.playAtMs);
    this.compact();
  }

  /** Load a past window for replay; positions events by their real timestamps. */
  loadReplay(input: FlowEventInput[], windowStartMs: number, windowEndMs: number): void {
    this.mode = "replay";
    this.windowStartMs = windowStartMs;
    this.windowEndMs = windowEndMs;
    this.events = input
      .map((e) => ({
        id: e.id,
        edgeId: e.edgeId,
        direction: e.direction,
        fromCustomerId: e.fromCustomerId,
        toCustomerId: e.toCustomerId,
        playAtMs: toMs(e.occurredAt),
      }))
      .sort((a, b) => a.playAtMs - b.playAtMs);
    this.seek(windowStartMs);
    this.playing = true;
  }

  /** Jump the playhead. Clears in-flight particles and re-points the spawn cursor. */
  seek(playheadMs: number): void {
    this.playheadMs = playheadMs;
    this.particles.length = 0;
    // First event strictly after the playhead.
    let lo = 0;
    let hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.events[mid]!.playAtMs <= playheadMs) lo = mid + 1;
      else hi = mid;
    }
    this.pointer = lo;
  }

  setSpeed(speed: number): void {
    this.speed = speed;
  }

  setPlaying(playing: boolean): void {
    this.playing = playing;
  }

  /** Advance the clock, spawn due events, and expire finished particles. */
  advance(nowMs = Date.now()): void {
    const realDelta = nowMs - this.lastRealMs;
    this.lastRealMs = nowMs;

    if (this.mode === "live") {
      this.playheadMs = nowMs;
    } else if (this.playing) {
      this.playheadMs = Math.min(this.windowEndMs, this.playheadMs + realDelta * this.speed);
      if (this.playheadMs >= this.windowEndMs) this.playing = false;
    }

    let spawnedThisFrame = 0;
    while (
      this.pointer < this.events.length &&
      this.events[this.pointer]!.playAtMs <= this.playheadMs
    ) {
      const ev = this.events[this.pointer]!;
      this.pointer++;
      if (spawnedThisFrame >= MAX_SPAWN_PER_FRAME || this.particles.length >= MAX_ACTIVE) {
        this.overflow++;
        continue;
      }
      // Vary duration by id hash so concurrent packets don't move in lockstep.
      const jitter = (hashId(ev.id) % 1000) / 1000;
      this.particles.push({
        edgeId: ev.edgeId,
        fromCustomerId: ev.fromCustomerId,
        toCustomerId: ev.toCustomerId,
        direction: ev.direction,
        startMs: nowMs,
        durationMs: PARTICLE_MIN_MS + jitter * (PARTICLE_MAX_MS - PARTICLE_MIN_MS),
      });
      spawnedThisFrame++;
    }

    // Drop finished particles in place.
    for (let i = this.particles.length - 1; i >= 0; i--) {
      if (nowMs - this.particles[i]!.startMs >= this.particles[i]!.durationMs) {
        this.particles.splice(i, 1);
      }
    }
  }

  // Trim already-spawned events so the live queue can't grow without bound.
  private compact(): void {
    if (this.pointer > 1000) {
      this.events = this.events.slice(this.pointer);
      this.pointer = 0;
    }
  }
}

function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}
