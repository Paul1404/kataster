import { cn } from "@/lib/utils";

// The Kataster mark: a bounded register with one highlighted parcel. Lines follow
// currentColor so the mark sits on either theme; the parcel takes the brand
// colour (--color-parcel), which is the only accent the mark ever carries.
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn("text-foreground", className)}
      role="img"
      aria-label="Kataster"
    >
      <rect x="3" y="3" width="11" height="7" fill="var(--color-parcel)" />
      <g stroke="currentColor" strokeWidth={1.5} strokeLinejoin="miter" strokeLinecap="square">
        <rect x="3.75" y="3.75" width="16.5" height="16.5" fill="none" />
        <path d="M3.75 10h10.25M14 3.75v16.5" />
      </g>
    </svg>
  );
}
