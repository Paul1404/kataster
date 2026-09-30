import { createFileRoute, redirect } from "@tanstack/react-router";

// Entry redirect. /dashboard is auth-guarded and bounces to /sign-in when needed.
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: "/dashboard" });
  },
});
