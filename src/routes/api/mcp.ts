import { createFileRoute } from "@tanstack/react-router";
import { handleMcpRequest } from "@/server/http/mcp-handler";

// MCP (Model Context Protocol) endpoint. Stateless Streamable-HTTP: agents POST
// JSON-RPC (initialize / tools/list / tools/call). Auth is a bearer token created
// in-app (Settings); LFIO_MCP_TOKEN still works as an optional env fallback.
// The whole endpoint is gated behind MCP_ENABLED (default off).
export const Route = createFileRoute("/api/mcp")({
  server: {
    handlers: {
      POST: ({ request }: { request: Request }) => handleMcpRequest(request),
    },
  },
});
