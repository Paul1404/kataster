import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { relativeTime } from "@/lib/format";
import { orpc, orpcClient } from "@/lib/orpc";

export const Route = createFileRoute("/_app/connections/")({
  component: ConnectionsPage,
});

function ConnectionsPage() {
  const queryClient = useQueryClient();
  const { data } = useQuery(orpc.connections.list.queryOptions());
  const remove = useMutation({
    mutationFn: (id: string) => orpcClient.connections.remove({ id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.connections.key() }),
    onError: (err) => toast.error(err instanceof Error ? err.message : "Löschen fehlgeschlagen"),
  });

  const connections = data ?? [];

  return (
    <div>
      <PageHeader
        title="Verbindungen"
        description="Wiederverwendbare, verschlüsselte Zugangsdaten. Einmal eingerichtet, von vielen Prüfungen genutzt."
        actions={
          <Button asChild>
            <Link to="/connections/new">
              <Plus />
              Verbindung hinzufügen
            </Link>
          </Button>
        }
      />
      <div className="p-8">
        <Card>
          {connections.length === 0 ? (
            <div className="p-12 text-center text-sm text-muted-foreground">
              Noch keine Verbindungen. Hinterlege Zugangsdaten, um Connectoren wie AWS Route 53 zu
              nutzen.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Connector</TableHead>
                  <TableHead>Hinterlegte Felder</TableHead>
                  <TableHead>Aktualisiert</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {connections.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">
                      <Link
                        to="/connections/$connectionId"
                        params={{ connectionId: c.id }}
                        className="hover:underline"
                      >
                        {c.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {c.connectorName}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {c.setFields.map((f) => (
                          <Badge key={f} variant="muted">
                            {f}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {relativeTime(c.updatedAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          asChild
                          aria-label="Verbindung bearbeiten"
                        >
                          <Link
                            to="/connections/edit/$connectionId"
                            params={{ connectionId: c.id }}
                          >
                            <Pencil className="text-muted-foreground" />
                          </Link>
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => {
                            if (confirm(`Verbindung „${c.name}“ löschen?`)) remove.mutate(c.id);
                          }}
                          aria-label="Verbindung löschen"
                        >
                          <Trash2 className="text-muted-foreground" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      </div>
    </div>
  );
}
