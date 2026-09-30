import { CheckSquare, Square, UserRound, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export interface CustomerOption {
  id: string;
  name: string;
}

/**
 * The one bulk-assignment control used across the app: select all visible,
 * clear, pick a customer, assign (or unassign) the selection. Extra actions
 * that only make sense on one page (e.g. "apply suggestions") slot in via
 * `extra`. Sticks to the bottom of the viewport while rows are selected so it
 * stays reachable on long lists.
 */
export function BulkAssignBar({
  selectedCount,
  visibleCount,
  allSelected,
  onSelectAll,
  onClear,
  customers,
  onAssign,
  allowUnassign = false,
  busy = false,
  extra,
  sticky = true,
  className,
}: {
  selectedCount: number;
  visibleCount: number;
  allSelected: boolean;
  onSelectAll: () => void;
  onClear: () => void;
  customers: CustomerOption[];
  onAssign: (customerId: string | null) => Promise<void> | void;
  allowUnassign?: boolean;
  busy?: boolean;
  extra?: ReactNode;
  sticky?: boolean;
  className?: string;
}) {
  const [target, setTarget] = useState("");
  const hasSelection = selectedCount > 0;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card/95 p-2 backdrop-blur",
        sticky && hasSelection && "sticky bottom-3 z-20 shadow-lg",
        className,
      )}
    >
      <Button
        variant="ghost"
        size="sm"
        onClick={allSelected ? onClear : onSelectAll}
        disabled={visibleCount === 0}
      >
        {allSelected ? <CheckSquare className="size-4" /> : <Square className="size-4" />}
        {allSelected ? "Auswahl aufheben" : `Alle ${visibleCount} wählen`}
      </Button>
      <span className="text-xs text-muted-foreground">
        {hasSelection ? `${selectedCount} ausgewählt` : "Nichts ausgewählt"}
      </span>
      {hasSelection && (
        <button
          type="button"
          onClick={onClear}
          className="text-muted-foreground hover:text-foreground"
          aria-label="Auswahl aufheben"
        >
          <X className="size-3.5" />
        </button>
      )}
      {extra}
      <div className="ml-auto flex items-center gap-2">
        <Select value={target} onValueChange={setTarget}>
          <SelectTrigger className="h-8 w-52">
            <UserRound className="mr-2 size-3.5 text-muted-foreground" />
            <SelectValue placeholder="Kunde wählen" />
          </SelectTrigger>
          <SelectContent>
            {customers.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          disabled={busy || !hasSelection || !target}
          onClick={() => onAssign(target)}
        >
          {selectedCount > 0 ? `${selectedCount} zuordnen` : "Zuordnen"}
        </Button>
        {allowUnassign && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !hasSelection}
            onClick={() => onAssign(null)}
            title="Zuordnung der Auswahl entfernen"
          >
            Entfernen
          </Button>
        )}
      </div>
    </div>
  );
}
