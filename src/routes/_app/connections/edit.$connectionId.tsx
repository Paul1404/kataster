import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ConnectionForm } from "@/components/connections/connection-form";
import { PageHeader } from "@/components/page-header";
import { orpc } from "@/lib/orpc";

export const Route = createFileRoute("/_app/connections/edit/$connectionId")({
  component: EditConnectionPage,
});

function EditConnectionPage() {
  const { connectionId } = Route.useParams();
  const { data } = useQuery(orpc.connections.list.queryOptions());
  const connection = data?.find((c) => c.id === connectionId);

  return (
    <div>
      <PageHeader title="Verbindung bearbeiten" description={connection?.name} />
      {connection ? (
        <ConnectionForm
          connection={{
            id: connection.id,
            name: connection.name,
            connectorId: connection.connectorId,
            connectorName: connection.connectorName,
          }}
        />
      ) : (
        <div className="p-8 text-sm text-muted-foreground">Lade…</div>
      )}
    </div>
  );
}
