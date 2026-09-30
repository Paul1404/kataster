import { createFileRoute, redirect } from "@tanstack/react-router";

// The margin page became /costs when per-customer money moved to /billing.
// Kept as a redirect so existing bookmarks and open tabs keep working.
export const Route = createFileRoute("/_app/margin")({
  beforeLoad: () => {
    throw redirect({ to: "/costs", replace: true });
  },
});
