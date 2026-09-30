import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ConnectorForm } from "@/components/assets/connector-form";
import { PageHeader } from "@/components/page-header";
import { orpc } from "@/lib/orpc";

export const Route = createFileRoute("/_app/assets/edit/$assetId")({
  component: EditAssetPage,
});

function EditAssetPage() {
  const { assetId } = Route.useParams();
  const { data: asset } = useQuery(orpc.assets.get.queryOptions({ input: { id: assetId } }));

  return (
    <div>
      <PageHeader title="Prüfung bearbeiten" description={asset?.name} />
      {asset ? (
        <ConnectorForm
          asset={{
            id: asset.id,
            name: asset.name,
            connectorId: asset.connectorId,
            target: asset.target,
            config: asset.config,
            tags: asset.tags,
            connectionId: asset.connectionId,
            intervalSeconds: asset.intervalSeconds,
            enabled: asset.enabled,
            customerId: asset.customerId,
          }}
        />
      ) : (
        <div className="p-8 text-sm text-muted-foreground">Lade…</div>
      )}
    </div>
  );
}
