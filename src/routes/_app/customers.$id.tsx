import { createFileRoute } from "@tanstack/react-router";
import { CustomerDetail } from "@/components/customer-detail";

export const Route = createFileRoute("/_app/customers/$id")({
  component: () => <CustomerDetail id={Route.useParams().id} />,
});
