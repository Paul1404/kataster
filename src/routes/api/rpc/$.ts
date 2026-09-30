import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { createFileRoute } from "@tanstack/react-router";
import { router } from "@/server/orpc/router";

const handler = new RPCHandler(router, {
  interceptors: [
    onError((error) => {
      console.error("[orpc]", error);
    }),
  ],
});

async function handle({ request }: { request: Request }) {
  const { matched, response } = await handler.handle(request, {
    prefix: "/api/rpc",
    context: { headers: request.headers },
  });
  if (matched) return response;
  return new Response("Not Found", { status: 404 });
}

export const Route = createFileRoute("/api/rpc/$")({
  server: {
    handlers: {
      GET: handle,
      POST: handle,
      PUT: handle,
      PATCH: handle,
      DELETE: handle,
    },
  },
});
