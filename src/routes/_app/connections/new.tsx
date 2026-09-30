import { createFileRoute } from "@tanstack/react-router";
import { ConnectionForm } from "@/components/connections/connection-form";
import { PageHeader } from "@/components/page-header";

export const Route = createFileRoute("/_app/connections/new")({
  component: NewConnectionPage,
});

function NewConnectionPage() {
  return (
    <div>
      <PageHeader
        title="Verbindung hinzufügen"
        description="Zugangsdaten werden vor dem Speichern verschlüsselt."
      />
      <ConnectionForm />
    </div>
  );
}
