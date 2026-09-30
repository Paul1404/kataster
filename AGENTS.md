# Repository guidance

This is the canonical instruction file for Kataster. The Railway project is
`kataster`, with `kataster-app`, `kataster-worker`, `kataster-postgres`, and
`kataster-redis`. Environment variables retain the `LFIO_` compatibility prefix.
Claude Code loads this file through `CLAUDE.md`.

## Start here

- Inspect the branch, upstream divergence, status, and diff before editing.
- Preserve pre-existing and unrelated changes.
- Use the repository's Bun and TanStack stack. Do not migrate frameworks or
  package managers as unrelated cleanup.
- Verify current documentation before changing fast-moving dependencies or
  Railway behavior.
- Keep changes focused on the requested outcome.

## Product and architecture

Kataster is a register for hosted infrastructure: which objects exist
(domains, mail, hosts, containers, cloud projects, certificates), which
customer owns each one, what it costs, and what is invoiced for it.

- Connectors live in `src/server/connectors/` and declare configuration plus a
  health check. `kind` is `probe` (one service's health) or `source` (a provider
  account sync feeding inventory and cost); the Prüfungen page lists them apart.
- Credentials are encrypted at rest. Never log or expose decrypted values.
- The web service and BullMQ worker share one image but have separate Railway
  start commands and service settings.
- Server-only code stays under `src/server/`. Code under `src/server/` and
  `src/worker/` must import by relative path, never through the `@/` alias: the
  worker runs from source and the runtime image ships no tsconfig, so an alias
  there type-checks and builds but crash-loops in production. A test enforces
  this. Components use oRPC and never
  import the database, server auth, or server services.
- Every protected procedure enforces authorization itself.
- Resources are Configuration Items with a lifecycle: `resources.status` is
  `active` or `decommissioned`. Connectors never delete a CI; a resource no
  source reports any more is decommissioned (owner, cost history and audit
  trail stay) and re-activated when seen again. Lists, counts, cost
  allocation and billing consider active CIs only unless asked otherwise.
- `resources.ownerCustomerId` is the single source of truth for ownership.
  Connector seeds must set `preserveOwner: true` so a sync only ever fills an
  empty owner; mirroring a legacy typed table (`mailboxes.customerId`,
  `domains.customerId`) overwrites what a human set, and the worker's
  suggestion pass then re-assigns it on the next check (owner thrash once a
  minute, audit trail full of noise). Procedures that write those typed tables
  must mirror the change onto the CI with `assignOwnerWithHistory`.
- Owner and status changes go through `src/server/resources/history.ts`
  (`assignOwnerWithHistory`, `setResourceStatus`) so `resource_history`
  records who changed what: `user:<email>`, `worker`, or `mcp`. Never update
  `resources.ownerCustomerId` or `resources.status` directly.
- The Objekte explorer (`/objects`) keeps its filters in validated URL search
  params; new list views should follow that pattern instead of local state.
- `/dashboard` is the operator cockpit, not a monitoring overview: money for the
  current period (Kosten, Berechnet, Marge, Eigenaufwand from
  `loadMarginReport`), a prioritised "Handlungsbedarf" list, the inventory
  rollup, the newest `resource_history` entries, and a demoted monitoring
  strip. It reads one procedure, `dashboard.cockpit`; extend that payload
  instead of adding client queries. The action rows are built by the pure
  `src/lib/cockpit-actions.ts` (tested), so ordering and wording change there.
- The command palette (`src/components/command-palette.tsx`, mounted in the app
  shell) opens with Cmd+K or Ctrl+K and searches customers, active CIs and
  checks plus the static pages. It is backed by the single `search.palette`
  procedure with per-group caps; ranking lives in `src/server/search/rank.ts`
  and result grouping in `src/lib/command-palette.ts`, both tested.
- `src/routeTree.gen.ts` and Drizzle migrations are generated. Regenerate them
  through project scripts rather than editing them manually.
- MCP access is read-only by default. Write-scoped ownership and pricing
  changes must remain authorized and audited.
- Brand: the product is "Kataster" (German land register). Sources live in
  `brand/`; `bun run icons` regenerates `public/` from them. The brand accent
  is the teal parcel (`--color-parcel`, also `--primary`); Signal blue stays
  for charts and the "up" status. No color is ever stored per customer.
- The user interface is German. Every user-visible string (pages, components,
  connector names, descriptions, setup guides, field titles, check messages,
  and oRPC error messages that reach a toast) is written in German. Code,
  identifiers, URLs, log lines, and MCP tool names stay English. Format
  numbers, currency, and dates through `src/lib/format.ts` (de-DE).
- Resource footprint matters: the Railway bill is mostly idle memory. The
  image runs Bun with `BUN_OPTIONS=--smol`; connectors declare a
  `defaultIntervalSeconds` (inventory/cost connectors 15 to 30 min, health
  probes 60 s). Do not add per-minute polling of provider APIs, and drop heavy
  raw payloads from check results before they are persisted.
- Money is split by direction: `/billing` ("Abrechnung") is the output, i.e.
  readiness plus per-customer statements and margin. `/costs` ("Kosten") is the
  input, i.e. provider cost pools and how they are allocated to resources. Do
  not reintroduce a per-customer margin table on the costs page.
- Tenant billing lives in `src/server/costs/billing.ts` (pure engine) and
  `src/server/billing/service.ts` (DB loader shared by the oRPC router, the
  MCP server, and the worker). Prices are contract positions
  (`contract_positions`: label, quantity, unit price, monthly/yearly/once,
  start and optional end period); `customer_pricing` holds one-off
  adjustments for a single period only. Unowned resources get owner
  suggestions; the worker applies high-confidence ones (owned parent or owned
  domain) unless `BILLING_AUTO_ASSIGN=false`. Name-only matches stay
  suggestions for the Abrechnung page.
- Cost allocation (`src/server/costs/auto-allocate.ts`): a resource draws from
  at most one pool per period (`cost_allocations` is unique per resource and
  period), so `computeAutoAllocations` must never emit a resource twice. One
  duplicate fails the whole upsert and every source check goes "Eingeschränkt"
  with a `Kostenverteilung` failure. A pool scoped to a leaf (a Route 53 zone
  pool on its Domain CI) lands on that leaf; one scoped to an aggregate (host,
  Railway project) splits across what it serves. Resolve allocations to cents
  with `resolveAllocationsCents` (largest remainder per pool), never row by row,
  so a pool's shares add up to the pool exactly.
- Drizzle trap: inside a `sql` template used as a select field, `${table.col}`
  renders unqualified. In a correlated subquery that silently binds to the inner
  table's column of the same name, so spell the outer column out
  (`"assets"."id"`).
- Invoicing closes the chain: `src/server/invoices/build.ts` (pure lines, VAT
  and numbering) and `src/server/invoices/service.ts` (DB, lifecycle). An
  invoice is an immutable snapshot: lines, totals and the recipient block are
  frozen at creation and never recomputed from the current contract positions,
  so `/invoices/$id` renders stored rows only. Numbers are `YYYY-NNNN`, gapless
  and sequential per calendar year, allocated inside the insert transaction
  under a `pg_advisory_xact_lock`; only the highest number of a year may be
  deleted (drafts only), anything else is voided. The sender block comes from
  `INVOICE_SENDER_*` environment variables, never from the database. A VAT rate
  of 0 prints the small-business note (Paragraph 19 UStG).

- Outbound notifications live in `src/server/notifications/`. `events.ts` is the
  pure engine (state plus enabled rules in, `{ruleKind, dedupeKey, title, body}`
  out) and is the only place alert wording belongs. `deliver.ts` claims a
  `notification_deliveries` row by its unique `dedupe_key` before it POSTs, so
  an event can never be sent twice; a failed attempt keeps its row and releases
  the key for a later retry. The webhook body carries `title`, `message`, `text`
  and `content` at once, which makes one URL work for ntfy, Slack and Discord.
  Incidents notify in real time from `persistCheckResult`; expiry, worker_down
  and billing_incomplete run once a day on the existing maintenance queue. Do
  not add a new always-on poll for alerting.

## Commands

- `bun run dev`: start the web application
- `bun run worker`: start the background worker
- `bun run typecheck`: TypeScript validation
- `bun run lint`: Biome validation
- `bun run test`: fast tests
- `bun run build`: production build
- `bun run db:generate`: generate a migration
- `bun run db:migrate:prod`: production migrator

The detailed previous guide is preserved in `docs/agent-reference.md`. Read its
project-specific sections when changing deployment, encryption, MCP, database,
or UI behavior.

## Verification

Public examples and screenshots use fictional customers, reserved example
domains, and synthetic costs. Never publish runtime credentials, inventory,
provider responses, or database exports. Applied migrations retain their exact
contents; do not rewrite them to anonymize examples. See `docs/publication.md`.
Public signup stays disabled. Provision operators only with the terminal-only
`bun run user:create` command; each operator can access the entire register.

Run the checks relevant to the change, including type checking, tests, and the
production build. Exercise the affected connector, worker, API, or UI workflow.
Do not treat a build or deployment acknowledgement as proof of live behavior.

## Maintaining this file

Update this file when a verified, durable repository rule changes. Keep it
concise and move detailed explanations to `docs/`. Keep `CLAUDE.md` as the
compatibility import unless Claude-specific guidance is genuinely required.
