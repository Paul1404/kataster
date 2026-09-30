import { useCallback, useMemo, useState } from "react";

/**
 * Multi-select state for a list of ids. Used by every bulk-action bar so the
 * behaviour (toggle, select all visible, clear, prune ids that vanished) is
 * identical across pages.
 */
export function useSelection(visibleIds: string[]) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const visible = useMemo(() => new Set(visibleIds), [visibleIds]);

  // Ids that are still on screen. Rows can disappear after an assignment or a
  // filter change; those must not linger in the selection.
  const active = useMemo(
    () => new Set([...selected].filter((id) => visible.has(id))),
    [selected, visible],
  );

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const selectAll = useCallback(() => setSelected(new Set(visibleIds)), [visibleIds]);
  const clear = useCallback(() => setSelected(new Set()), []);
  const allSelected = visibleIds.length > 0 && active.size === visibleIds.length;

  return { selected: active, toggle, selectAll, clear, allSelected };
}
