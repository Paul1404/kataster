/**
 * Kataster production server (Bun).
 * Serves the static client build from dist/client and forwards everything
 * else to the TanStack Start server entry. Listens on PORT (Railway injects it).
 */
import { join, normalize } from "node:path";

const PORT = Number(process.env.PORT ?? 3000);
// When set, requests for any other host are redirected here (permanent). Lets
// an old hostname keep working as a redirect after a rename.
const CANONICAL_HOST = process.env.CANONICAL_HOST?.trim().toLowerCase() || null;
const CLIENT_DIR = "./dist/client";
const SERVER_ENTRY = "./dist/server/server.js";

const serverModule = (await import(SERVER_ENTRY)) as {
  default: { fetch: (request: Request) => Response | Promise<Response> };
};
const handler = serverModule.default;

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

// Apply baseline security headers to every response without clobbering existing
// content-type/cache-control headers set upstream.
function withSecurityHeaders(response: Response): Response {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
}

const server = Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);

    // Redirect only public traffic on a foreign hostname. Railway's health check
    // and private-network calls arrive with internal hostnames and must get the
    // real response, or every deploy fails its health check.
    const host = url.hostname.toLowerCase();
    const isInternal =
      host === "localhost" ||
      host.endsWith(".railway.internal") ||
      host.endsWith(".railway.app") ||
      url.pathname === "/api/health";
    if (CANONICAL_HOST && !isInternal && host !== CANONICAL_HOST) {
      const target = new URL(url);
      target.protocol = "https:";
      target.host = CANONICAL_HOST;
      return withSecurityHeaders(Response.redirect(target.toString(), 308));
    }

    // Serve static assets (hashed bundles, favicons, manifest) directly.
    if (request.method === "GET" && url.pathname !== "/" && !url.pathname.includes("..")) {
      const file = Bun.file(normalize(join(CLIENT_DIR, url.pathname)));
      if (await file.exists()) {
        const immutable = url.pathname.startsWith("/assets/");
        return withSecurityHeaders(
          new Response(file, {
            headers: {
              "cache-control": immutable
                ? "public, max-age=31536000, immutable"
                : "public, max-age=86400",
            },
          }),
        );
      }
    }

    try {
      return withSecurityHeaders(await handler.fetch(request));
    } catch (error) {
      console.error("[server] handler error", error);
      return withSecurityHeaders(new Response("Internal Server Error", { status: 500 }));
    }
  },
});

console.log(`[kataster] server listening on http://localhost:${server.port}`);
