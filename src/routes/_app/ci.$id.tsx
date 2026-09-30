import { createFileRoute } from "@tanstack/react-router";
import { CIDetail } from "@/components/ci-detail";

export const Route = createFileRoute("/_app/ci/$id")({
  component: () => <CIDetail id={Route.useParams().id} backTo="/ci" />,
});
