import { createFileRoute } from "@tanstack/react-router";
import { handleHealthRequest } from "@/server/http/health-handler";

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: handleHealthRequest,
    },
  },
});
