export function periodScopedKey(period: string, id: string): string {
  return `${period}:${id}`;
}
