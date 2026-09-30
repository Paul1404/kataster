// The canonical id for a derived "mail" edge: from a mailcow server's location to
// a customer location it serves. Both the dashboard map payload and the mail-event
// resolver build ids with this so a particle's edgeId always matches a MapEdge.id.
export function mailEdgeId(serverCustomerId: string, endpointCustomerId: string): string {
  return `mail:${serverCustomerId}:${endpointCustomerId}`;
}
