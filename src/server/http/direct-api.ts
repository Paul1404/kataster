import { handleHealthRequest } from "./health-handler";
import { handleMcpRequest } from "./mcp-handler";

export function handleDirectApiRequest(request: Request): Response | Promise<Response> | null {
  const { pathname } = new URL(request.url);
  if (request.method === "GET" && pathname === "/api/health") {
    return handleHealthRequest();
  }
  if (request.method === "POST" && pathname === "/api/mcp") {
    return handleMcpRequest(request);
  }
  return null;
}
