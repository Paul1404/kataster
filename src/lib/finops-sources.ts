/** Sources that contribute inventory or financial data. Health probes are retired. */
export const FINOPS_SOURCE_IDS = ["aws", "railway", "hetzner-cloud", "managed-host"] as const;
export function isFinopsSource(id: string): boolean {
  return (FINOPS_SOURCE_IDS as readonly string[]).includes(id);
}
