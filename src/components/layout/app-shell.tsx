import { Link, useNavigate } from "@tanstack/react-router";
import {
  Boxes,
  Database,
  Globe,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Mailbox,
  MapPin,
  Menu,
  Receipt,
  ReceiptEuro,
  Server,
  Settings,
  Wallet,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { BrandMark } from "@/components/brand-mark";
import { CommandPalette } from "@/components/command-palette";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { signOut } from "@/lib/auth-client";

const NAV = [
  { to: "/dashboard", label: "Übersicht", icon: LayoutDashboard },
  { to: "/customers", label: "Kunden", icon: MapPin },
  { to: "/objects", label: "Objekte", icon: Boxes },
  { to: "/billing", label: "Abrechnung", icon: Receipt },
  { to: "/invoices", label: "Rechnungen", icon: ReceiptEuro },
  { to: "/costs", label: "Kosten", icon: Wallet },
  { to: "/domains", label: "Mail-Domains", icon: Mailbox },
  { to: "/sources", label: "Datenquellen", icon: Database },
  { to: "/hosts", label: "Hosts", icon: Server },
  { to: "/ci", label: "Domains", icon: Globe },
  { to: "/connections", label: "Verbindungen", icon: KeyRound },
  { to: "/settings", label: "Einstellungen", icon: Settings },
] as const;

export function AppShell({ userEmail, children }: { userEmail: string; children: ReactNode }) {
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);

  async function handleSignOut() {
    await signOut();
    await navigate({ to: "/sign-in" });
  }

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <CommandPalette />
      <aside className="hidden w-60 shrink-0 flex-col md:flex border-r border-border bg-card/40">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <BrandMark className="size-7" />
          <div className="leading-tight">
            <div className="text-sm font-semibold tracking-tight">Kataster</div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">FinOps</div>
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
        <header className="relative flex h-14 items-center justify-between gap-2 border-b border-border px-4 md:justify-end md:px-6">
          <Button
            variant="ghost"
            size="sm"
            className="md:hidden"
            aria-label="Navigation öffnen"
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen(!mobileOpen)}
          >
            <Menu className="size-4" />
            Kataster FinOps
          </Button>
          {mobileOpen && (
            <nav className="absolute left-0 top-14 z-50 grid w-full grid-cols-2 gap-1 border-b bg-card p-3 shadow-lg md:hidden">
              {NAV.map(({ to, label }) => (
                <Link
                  key={to}
                  to={to}
                  onClick={() => setMobileOpen(false)}
                  className="rounded px-3 py-2 text-sm hover:bg-accent"
                >
                  {label}
                </Link>
              ))}
              <Button variant="ghost" onClick={handleSignOut}>
                Abmelden
              </Button>
            </nav>
          )}
          <ThemeToggle />
        </header>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
