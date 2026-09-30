/**
 * Normalize a user-entered host/URL into an absolute base URL with no trailing
 * slash. Defaults to https:// when no scheme is given, so "host.example.com"
 * and "https://host.example.com/" both work.
 */
export function ensureBaseUrl(target: string): string {
  const trimmed = target.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withScheme.replace(/\/+$/, "");
}
