import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  buildGroups,
  EMPTY_PALETTE_DATA,
  flattenGroups,
  moveIndex,
  PALETTE_PAGES,
  type PaletteRow,
} from "@/lib/command-palette";
import { orpc } from "@/lib/orpc";
import { cn } from "@/lib/utils";

const DEBOUNCE_MS = 180;

/**
 * Global search and navigation. Cmd+K or Ctrl+K opens it anywhere in the app,
 * the arrow keys walk the results and Enter opens the selected one. Records come
 * from one debounced oRPC call; the static pages are matched on the client.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [debounced, setDebounced] = useState("");
  const [cursor, setCursor] = useState(0);
  const navigate = useNavigate();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(term), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [term]);

  const query = useQuery(
    orpc.search.palette.queryOptions({
      input: { query: debounced },
      enabled: open && debounced.trim().length >= 2,
      staleTime: 15_000,
    }),
  );

  const data =
    debounced.trim().length >= 2 ? (query.data ?? EMPTY_PALETTE_DATA) : EMPTY_PALETTE_DATA;
  const groups = useMemo(() => buildGroups(term, data), [term, data]);
  const rows = useMemo(() => flattenGroups(groups), [groups]);

  // Results shrink while typing, so the stored cursor is clamped on render
  // instead of being reset from an effect.
  const active = rows.length === 0 ? 0 : Math.min(cursor, rows.length - 1);

  function reset() {
    setOpen(false);
    setTerm("");
    setDebounced("");
    setCursor(0);
  }

  function go(row: PaletteRow) {
    reset();
    switch (row.kind) {
      case "customer":
        navigate({ to: "/customers/$id", params: { id: row.id } });
        return;
      case "resource":
        navigate({ to: "/ci/$id", params: { id: row.id } });
        return;
      case "asset":
        navigate({ to: "/assets/$assetId", params: { assetId: row.id } });
        return;
      case "page": {
        const page = PALETTE_PAGES.find((p) => p.to === row.id);
        if (page) navigate({ to: page.to });
      }
    }
  }

  function onInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setCursor(moveIndex(active, event.key === "ArrowDown" ? 1 : -1, rows.length));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const row = rows[active];
      if (row) go(row);
    }
  }

  // Keep the highlighted row inside the scroll area while arrowing through it.
  useEffect(() => {
    const options = listRef.current?.querySelectorAll<HTMLElement>("[role='option']");
    options?.item(active)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const activeRow = rows[active];

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : reset())}>
      <DialogContent aria-describedby="command-palette-hint" className="p-0">
        <DialogTitle className="sr-only">Suche und Navigation</DialogTitle>
        <DialogDescription id="command-palette-hint" className="sr-only">
          Tippe, um Kunden, Objekte und Prüfungen zu finden. Mit den Pfeiltasten wählen, mit Enter
          öffnen.
        </DialogDescription>
        <div className="flex items-center gap-2 border-b border-border px-4">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            autoFocus
            value={term}
            onChange={(e) => {
              setTerm(e.target.value);
              setCursor(0);
            }}
            onKeyDown={onInputKeyDown}
            placeholder="Kunden, Objekte, Prüfungen oder Seiten suchen"
            aria-label="Suchbegriff"
            aria-controls="command-palette-results"
            aria-activedescendant={
              activeRow ? `palette-${activeRow.kind}-${activeRow.id}` : undefined
            }
            className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
            Esc
          </kbd>
        </div>

        <div ref={listRef} className="max-h-[52vh] overflow-y-auto p-2">
          {rows.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-muted-foreground">
              {query.isFetching ? "Suche läuft…" : "Nichts gefunden."}
            </div>
          ) : (
            <div id="command-palette-results" role="listbox" aria-label="Suchergebnisse">
              {groups.map((group) => (
                <div key={group.key} className="mb-1 last:mb-0">
                  <div className="px-3 py-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
                    {group.label}
                  </div>
                  {group.rows.map((row) => {
                    const index = rows.indexOf(row);
                    const isActive = index === active;
                    return (
                      <button
                        key={`${row.kind}-${row.id}`}
                        id={`palette-${row.kind}-${row.id}`}
                        type="button"
                        role="option"
                        aria-selected={isActive}
                        data-active={isActive}
                        onMouseEnter={() => setCursor(index)}
                        onClick={() => go(row)}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm",
                          isActive ? "bg-accent text-foreground" : "text-muted-foreground",
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                          {row.label}
                        </span>
                        {row.sublabel && (
                          <span className="hidden max-w-[14rem] truncate text-xs sm:block">
                            {row.sublabel}
                          </span>
                        )}
                        <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px]">
                          {row.typeLabel}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
