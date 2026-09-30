import defaultHandler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { handleDirectApiRequest } from "./server/http/direct-api";

// Machine-facing endpoints account for almost all Kataster requests. Dispatch them
// before TanStack Start constructs a router and SSR stream for every call.
export default createServerEntry({
  async fetch(request) {
    const directResponse = handleDirectApiRequest(request);
    if (directResponse) return directResponse;
    return defaultHandler.fetch(request);
  },
});
