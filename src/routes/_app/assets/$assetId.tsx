import { createFileRoute, redirect } from "@tanstack/react-router";
export const Route = createFileRoute("/_app/assets/$assetId")({
  beforeLoad: () => {
    throw redirect({ to: "/sources" });
  },
});
