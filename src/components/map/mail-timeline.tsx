import { ArrowDownLeft, ArrowUpRight, History, Pause, Play, Radio } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DIRECTION_COLOR, type FlowController, type MailDirection } from "@/lib/mail-flow";
import { orpcClient } from "@/lib/orpc";
import { cn } from "@/lib/utils";

type Mode = "live" | "replay";
type WindowKey = "1h" | "24h";

const WINDOW_MS: Record<WindowKey, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
};
const SPEEDS = [1, 4, 16] as const;
// Resolution of the activity strip on the scrub bar (one dot per non-empty bucket).
const MARK_BUCKETS = 160;

function clockLabel(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

interface ActivityMark {
  /** Position along the track, 0..100 (%). */
  pos: number;
  count: number;
}

// Bucket event timestamps into the scrub-bar strip so a busy window shows a band of
// dots instead of thousands of overlapping nodes.
function computeMarks(
  events: { occurredAt: string | Date }[],
  start: number,
  end: number,
): ActivityMark[] {
  const span = end - start;
  if (span <= 0) return [];
  const counts = new Array<number>(MARK_BUCKETS).fill(0);
  for (const e of events) {
    const t = e.occurredAt instanceof Date ? e.occurredAt.getTime() : Date.parse(e.occurredAt);
    if (t < start || t > end) continue;
    const idx = Math.min(MARK_BUCKETS - 1, Math.floor(((t - start) / span) * MARK_BUCKETS));
    counts[idx]!++;
  }
  const out: ActivityMark[] = [];
  for (let i = 0; i < MARK_BUCKETS; i++) {
    if (counts[i]! > 0) out.push({ pos: ((i + 0.5) / MARK_BUCKETS) * 100, count: counts[i]! });
  }
  return out;
}

/**
 * Bottom overlay that drives the flow controller: a Live/Replay toggle plus, in
 * replay, a draggable playhead over a past window with play/pause and speed.
 */
export function MailTimeline({ controller }: { controller: FlowController }) {
  const [mode, setMode] = useState<Mode>("live");
  const [windowKey, setWindowKey] = useState<WindowKey>("1h");
  const [speed, setSpeed] = useState<number>(4);
  const [playing, setPlaying] = useState(true);
  const [bounds, setBounds] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
  const [playhead, setPlayhead] = useState(0);
  const [overflow, setOverflow] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [marks, setMarks] = useState<ActivityMark[]>([]);
  const reqId = useRef(0);

  // Mirror the controller's live playhead/overflow into React for the scrubber.
  useEffect(() => {
    const id = setInterval(() => {
      setPlayhead(controller.playheadMs);
      setOverflow(controller.overflow);
      if (controller.mode === "replay") setPlaying(controller.playing);
    }, 120);
    return () => clearInterval(id);
  }, [controller]);

  async function enterReplay(key: WindowKey) {
    const end = Date.now();
    const start = end - WINDOW_MS[key];
    setMode("replay");
    setWindowKey(key);
    setBounds({ start, end });
    setLoading(true);
    const myReq = ++reqId.current;
    try {
      const res = await orpcClient.mail.events.range({
        from: new Date(start).toISOString(),
        to: new Date(end).toISOString(),
      });
      if (myReq !== reqId.current) return;
      setTruncated(res.truncated);
      setMarks(computeMarks(res.events, start, end));
      controller.loadReplay(res.events, start, end);
      controller.setSpeed(speed);
      setPlaying(true);
    } finally {
      if (myReq === reqId.current) setLoading(false);
    }
  }

  function enterLive() {
    reqId.current++;
    setMode("live");
    setTruncated(false);
    setMarks([]);
    controller.setLive();
  }

  function togglePlay() {
    if (mode !== "replay") return;
    // Restart from the window start once the playhead has reached the end.
    if (!playing && controller.playheadMs >= bounds.end) controller.seek(bounds.start);
    const next = !playing;
    setPlaying(next);
    controller.setPlaying(next);
  }

  function cycleSpeed() {
    const idx = SPEEDS.indexOf(speed as (typeof SPEEDS)[number]);
    const next = SPEEDS[(idx + 1) % SPEEDS.length]!;
    setSpeed(next);
    controller.setSpeed(next);
  }

  function onScrub(value: number) {
    controller.seek(value);
    setPlayhead(value);
  }

  return (
    <div className="mail-timeline">
      <div className="flex items-center gap-1">
        <button
          type="button"
          className={cn("mail-tl-toggle", mode === "live" && "is-on")}
          onClick={enterLive}
        >
          <Radio className="size-3.5" />
          Live
        </button>
        <button
          type="button"
          className={cn("mail-tl-toggle", mode === "replay" && "is-on")}
          onClick={() => enterReplay(windowKey)}
        >
          <History className="size-3.5" />
          Wiedergabe
        </button>
      </div>

      {mode === "replay" ? (
        <>
          <button
            type="button"
            className="mail-tl-icon"
            onClick={togglePlay}
            aria-label="Abspielen/Pause"
          >
            {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
          </button>
          <button type="button" className="mail-tl-speed" onClick={cycleSpeed}>
            {speed}x
          </button>
          <span className="mail-tl-time">{clockLabel(playhead || bounds.start)}</span>
          <div className="mail-tl-track-wrap">
            <div className="mail-tl-marks" aria-hidden="true">
              {marks.map((m) => (
                <span
                  key={m.pos}
                  className="mail-tl-mark"
                  style={{ left: `${m.pos}%`, opacity: 0.45 + Math.min(0.5, m.count / 8) }}
                />
              ))}
            </div>
            <input
              type="range"
              className="mail-tl-track"
              min={bounds.start}
              max={bounds.end}
              value={Math.min(Math.max(playhead, bounds.start), bounds.end)}
              step={1000}
              onChange={(e) => onScrub(Number(e.target.value))}
            />
          </div>
          <span className="mail-tl-time">{clockLabel(bounds.end)}</span>
          <div className="mail-tl-window">
            {(["1h", "24h"] as WindowKey[]).map((k) => (
              <button
                key={k}
                type="button"
                className={cn("mail-tl-win", windowKey === k && "is-on")}
                onClick={() => enterReplay(k)}
              >
                {k}
              </button>
            ))}
          </div>
          {loading && <span className="mail-tl-note">lade…</span>}
          {truncated && <span className="mail-tl-note">gekürzt</span>}
        </>
      ) : (
        <span className="mail-tl-live-label">
          Mailverkehr live
          {overflow > 0 && <span className="mail-tl-note">· {overflow} gekürzt</span>}
        </span>
      )}
    </div>
  );
}

export interface MailFeedItem {
  id: string;
  direction: MailDirection;
  domain: string;
  counterparty: string | null;
  occurredAt: string | Date;
}

function relTime(when: string | Date): string {
  const ms = when instanceof Date ? when.getTime() : Date.parse(when);
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 60) return `${secs} s`;
  if (secs < 3600) return `${Math.round(secs / 60)} min`;
  return `${Math.round(secs / 3600)} h`;
}

/** Compact running list of the most recent mail events. */
export function MailActivityFeed({ items }: { items: MailFeedItem[] }) {
  if (items.length === 0) {
    return (
      <div className="space-y-2">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Mailaktivität
        </div>
        <p className="text-xs text-muted-foreground">
          Warte auf Mailverkehr. Sende oder empfange eine Nachricht, dann erscheint sie hier.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Mailaktivität
      </div>
      <div className="space-y-1">
        {items.map((it) => {
          const outbound = it.direction === "outbound";
          const Icon = outbound ? ArrowUpRight : ArrowDownLeft;
          return (
            <div
              key={it.id}
              className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm"
            >
              <Icon
                className="size-3.5 shrink-0"
                style={{ color: DIRECTION_COLOR[it.direction] }}
              />
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{it.domain}</span>
                {it.counterparty && (
                  <span className="text-muted-foreground">
                    {" "}
                    {outbound ? "→" : "←"} {it.counterparty}
                  </span>
                )}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {relTime(it.occurredAt)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
