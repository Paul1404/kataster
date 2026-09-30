import { timingSafeEqual } from "node:crypto";
import { handleMcpMessage } from "../mcp/server";
import { type McpTokenIdentity, verifyMcpToken } from "../mcp/tokens";
import { RequestBodyError, readJsonBody } from "./json-body";

const MAX_MCP_BODY_BYTES = 256 * 1024;
const MAX_MCP_BATCH_SIZE = 20;

export function extractBearer(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export async function handleMcpRequest(request: Request): Promise<Response> {
  if (process.env.MCP_ENABLED !== "true") {
    return new Response("Not Found", { status: 404 });
  }

  const token = extractBearer(request.headers.get("authorization"));
  if (!token) return Response.json({ error: "unauthorized" }, { status: 401 });

  const envToken = process.env.LFIO_MCP_TOKEN;
  let identity: McpTokenIdentity | null = null;
  if (envToken && timingSafeEqualStr(token, envToken)) {
    identity = {
      id: null,
      name: "environment token",
      scopes: process.env.LFIO_MCP_ENV_ACCESS === "write" ? ["read", "write"] : ["read"],
    };
  } else {
    identity = await verifyMcpToken(token);
  }
  if (!identity) return Response.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await readJsonBody(request, MAX_MCP_BODY_BYTES);
  } catch (error) {
    const status = error instanceof RequestBodyError ? error.status : 400;
    return Response.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: error instanceof Error ? error.message : "Parse error",
        },
      },
      { status },
    );
  }

  if (Array.isArray(body)) {
    if (body.length > MAX_MCP_BATCH_SIZE) {
      return Response.json(
        { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Batch too large" } },
        { status: 400 },
      );
    }
    const responses = [];
    for (const message of body) {
      const response = await handleMcpMessage(message, identity);
      if (response) responses.push(response);
    }
    return responses.length > 0 ? Response.json(responses) : new Response(null, { status: 202 });
  }

  const response = await handleMcpMessage(body as Record<string, unknown>, identity);
  return response ? Response.json(response) : new Response(null, { status: 202 });
}
