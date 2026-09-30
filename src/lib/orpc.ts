import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
// Type-only import: erased at build time so no server code reaches the client bundle.
import type { AppRouter } from "@/server/orpc/router";

const link = new RPCLink({
  url: () =>
    typeof window !== "undefined"
      ? `${window.location.origin}/api/rpc`
      : "http://localhost:3000/api/rpc",
  fetch: (request, init) => globalThis.fetch(request, { ...init, credentials: "include" }),
});

export const orpcClient: RouterClient<AppRouter> = createORPCClient(link);

// TanStack Query helpers: orpc.assets.list.queryOptions(), orpc.assets.create.mutationOptions(), etc.
export const orpc = createTanstackQueryUtils(orpcClient);
