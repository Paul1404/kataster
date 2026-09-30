import { Link, useNavigate } from "@tanstack/react-router";
import {
  Activity,
  Boxes,
  Globe,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Mailbox,
  Map as MapIcon,
  MapPin,
  Receipt,
  ReceiptEuro,
  Server,
  Settings,
  Wallet,
} from "lucide-react";
import type { ReactNode } from "react";
import { BrandMark } from "@/components/brand-mark";
import { CommandPalette } from "@/components/command-palette";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { signOut } from "@/lib/auth-client";

const NAV = [
  { to: "/dashboard", label: "Übersicht", icon: LayoutDashboard },
  { to: "/map", label: "Karte", icon: MapIcon },
  { to: "/customers", label: "Kunden", icon: MapPin },
  { to: "/objects", label: "Objekte", icon: Boxes },
  { to: "/billing", label: "Abrechnung", icon: Receipt },
  { to: "/invoices", label: "Rechnungen", icon: ReceiptEuro },
  { to: "/costs", label: "Kosten", icon: Wallet },
  { to: "/domains", label: "Mail-Domains", icon: Mailbox },
  { to: "/assets", label: "Prüfungen", icon: Activity },
  { to: "/hosts", label: "Hosts", icon: Server },
  { to: "/ci", label: "Domains", icon: Globe },
  { to: "/connections", label: "Verbindungen", icon: KeyRound },
  { to: "/settings", label: "Einstellungen", icon: Settings },
] as const;

export function AppShell({ userEmail, children }: { userEmail: string; children: ReactNode }) {
  const navigate = useNavigate();

  async function handleSignOut() {
    await signOut();
    await navigate({ to: "/sign-in" });
  }

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <CommandPalette />
      <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-card/40">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <BrandMark className="size-7" />
          <div className="leading-tight">
            <div className="text-sm font-semibold tracking-tight">Kataster</div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Register
            </div>
          </div>
        </div>
        <nav className="flex flex-1 flex-col gap-1 px-3 py-2">
          {NAV.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&.active]:bg-accent [&.active]:font-medium [&.active]:text-foreground"
              activeProps={{ className: "active" }}
            >
              <Icon className="size-4" />
              {label}
            </Link>
          ))}
        </nav>
        <div className="border-t border-border p-3">
          <div className="flex items-center justify-between gap-2 px-2 pb-2 text-xs text-muted-foreground">
            <span>Suche</span>
            <kbd className="rounded border border-border px-1.5 py-0.5 text-[10px]">⌘K</kbd>
          </div>
          <div className="truncate px-2 pb-2 text-xs text-muted-foreground" title={userEmail}>
            {userEmail}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            onClick={handleSignOut}
          >
            <LogOut className="size-4" />
            Abmelden
          </Button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-end gap-2 border-b border-border px-6">
          <ThemeToggle />
        </header>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
