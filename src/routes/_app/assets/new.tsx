import { createFileRoute } from "@tanstack/react-router";
import { ConnectorForm } from "@/components/assets/connector-form";
import { PageHeader } from "@/components/page-header";

export const Route = createFileRoute("/_app/assets/new")({
  component: NewAssetPage,
});

function NewAssetPage() {
  return (
    <div>
      <PageHeader
        title="Prüfung hinzufügen"
        description="Connector wählen und festlegen, was überwacht werden soll."
      />
      <ConnectorForm />
    </div>
  );
}
