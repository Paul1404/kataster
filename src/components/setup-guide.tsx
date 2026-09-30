import { Check, Copy, ExternalLink } from "lucide-react";
import { useState } from "react";
import { Card } from "@/components/ui/card";

export interface ConnectorSetup {
  intro?: string;
  steps: string[];
  commands?: string;
  docsUrl?: string;
}

function CommandBlock({ commands }: { commands: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={async () => {
          await navigator.clipboard.writeText(commands);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md border border-border bg-background/80 px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
      >
        {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
        {copied ? "Kopiert" : "Kopieren"}
      </button>
      <pre className="overflow-x-auto rounded-md border border-border bg-background p-3 pr-16 text-xs leading-relaxed">
        <code>{commands}</code>
      </pre>
    </div>
  );
}

export function SetupGuide({ setup, title }: { setup: ConnectorSetup; title?: string }) {
  return (
    <Card className="space-y-3 border-primary/30 bg-primary/5 p-5">
      <div className="text-sm font-medium">{title ?? "Einrichtung"}</div>
      {setup.intro && <p className="text-sm text-muted-foreground">{setup.intro}</p>}
      <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
        {setup.steps.map((step) => (
          <li key={step} className="pl-1 leading-relaxed">
            {step}
          </li>
        ))}
      </ol>
      {setup.commands && <CommandBlock commands={setup.commands} />}
      {setup.docsUrl && (
        <a
          href={setup.docsUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
        >
          <ExternalLink className="size-3.5" />
          Offizielle Dokumentation
        </a>
      )}
    </Card>
  );
}
