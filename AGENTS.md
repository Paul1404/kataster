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
  account sync feeding inventory and cost); the Datenquellen page exposes only FinOps inventory/cost sources.
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
- `/dashboard` is the FinOps cockpit: money for the
  current period (Kosten, Berechnet, Marge, Eigenaufwand from
  `loadMarginReport`), a prioritised "Handlungsbedarf" list, the inventory
  rollup, the newest `resource_history` entries, without monitoring or uptime
  panels. It reads one procedure, `dashboard.cockpit`; extend that payload
  instead of adding client queries. The action rows are built by the pure
  `src/lib/cockpit-actions.ts` (tested), so ordering and wording change there.
- The command palette (`src/components/command-palette.tsx`, mounted in the app
  shell) opens with Cmd+K or Ctrl+K and searches customers and active CIs
  plus the static pages. It is backed by the single `search.palette`
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

- Legacy notification implementation and storage remain under
  `src/server/notifications/` for historical reference. Active FinOps code does
  not collect monitoring events, schedule notification digests or deliver alarms.

WordPress probes request only `_fields=name,namespaces` from the REST index.
Preserve custom API paths and query-based `rest_route` parameters.

HTTP status probes must cancel unused response bodies after reading headers.
Do not buffer whole pages or leave streaming bodies open. Keep the observed
status, timeout, and certificate checks independent of body cleanup failures.

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
The portfolio seed is `bun run demo:seed`, restricted to an empty local
`kataster_demo_*` register. Screenshots and their reproduction boundary are
documented in `docs/demo.md`; never use production data or hide live warnings.

Run the checks relevant to the change, including type checking, tests, and the
production build. Exercise the affected connector, worker, API, or UI workflow.
Do not treat a build or deployment acknowledgement as proof of live behavior.

## Maintaining this file

Update this file when a verified, durable repository rule changes. Keep it
concise and move detailed explanations to `docs/`. Keep `CLAUDE.md` as the
compatibility import unless Claude-specific guidance is genuinely required.

## Readiness

`/api/health` performs bounded, read-only dependency checks and returns 503 on
failure with no connection details. Responses disable caching.
Both PostgreSQL and Redis must answer before the app is ready.
The worker exposes private `/api/health` on `$PORT` only after all three workers
are ready; it also checks PostgreSQL, Redis and the running worker loops.

## Dependency audit gate

CI runs the full `bun audit` against the committed lockfile before release
checks, including development tools.
Do not replace the lockfile audit with an empty Dependabot PR queue or suppress
an advisory merely to make the gate pass.

## Scoped dependency compatibility

The `@esbuild-kit/core-utils>esbuild` override is parent-scoped. Its regression
test checks both synchronous CommonJS and asynchronous ESM transforms used by
Drizzle Kit. Keep the override scoped and validate schema loading and migrations
when changing it. Nested overrides require a Bun version that supports lockfile
version 3; CI and production must use a compatible runtime.
`bunx drizzle-kit export --sql` validates loading the actual TypeScript schema
without connecting to a database; run it alongside the transform regression
tests after changing this loader override.

## TLS certificate probes

Certificate metadata probes use authenticated TLS. Send SNI only for DNS names,
never IP literals, and strip URL brackets from IPv6 hosts before connecting.
The connector regression exercises both Node (Vitest) and Bun (production)
against a real local TLS server; a rejected connection must actually reach it.

## Main-only branch lifecycle and security reporting

`main` is the only retained local and remote branch for this active Railway
repository. Temporary PR branches are allowed only while work is in progress.
Keep required checks and branch protections; never bypass them to avoid a branch.
Before finishing, merge validated work, delete the remote and local task branches,
remove clean worktrees created for the task, and verify that only `main` remains
with `git ls-remote --heads origin` and `git for-each-ref refs/heads`.

If a task cannot safely merge, preserve commits in a verified Git bundle outside
the checkout and save staged, unstaged and untracked changes. Detach any retained
worktree before deleting its task branch, and report the unfinished work and
recovery location. Never discard unrelated changes, retain an `archive/` branch,
or modify an archived repository to satisfy cleanup. A later explicit owner
instruction can retain a branch.

Follow `SECURITY.md` for vulnerability reports. Keep reports private and omit
credentials, production records and personal data from public issues and commits.

## Production security gates

Railway waits for successful GitHub workflows on `main`. Keep an always-running
push workflow and do not cancel its main-branch runs. PR branch cleanup never
justifies bypassing CI. Public repositories also enforce CodeQL results on main.
Container security builds the production image and scans OS and library packages.
Retain the complete report. Fixable HIGH/CRITICAL findings block delivery;
findings without a listed fixed package for the current distribution remain visible and require explicit review. Do not add
blanket scanner ignores or weaken these gates to make a release pass.

## Runtime package pruning

`scripts/prune-runtime-packages.sh` runs only during image construction, after
all native packages are installed. Its simulated purge accepts only an explicit
package allowlist and keeps dpkg dependencies valid. Do not add forced dependency
removal, delete package metadata or hide scanner findings. Keep shell/coreutils,
CA certificates and required C/C++ libraries. CI verifies the pruned image as its
non-root user; exercise the real PDF/image tools and startup workflows before
merging. Rebuild images for package updates, never mutate a running deployment.

## Current managed-host inventory

`managed-host` consumes the secret-free push report documented in
`docs/host-inventory.md`. The dedicated `host:<hostname>` token can call only
`sync_host_inventory` for that host. Keep host credentials out of MCP arguments,
responses and audit details; registration accepts only a SHA-256 hash.
Preserve mailbox CI IDs and manually assigned owners when adopting Stalwart.
A mixed host's cost pool serves both its containers and its own mailboxes.
B2 amounts are explicitly storage estimates, never invoice or payment evidence.
Retiring a source disables checks and closes its incidents with the retirement
reason while retaining resources, ownership and historical cost records.

Kataster is FinOps. Do not restore maps, uptime panels, patch monitoring, mail
event polling, incident lists or alarm delivery. `/sources` reports only inventory
and financial synchronization. Legacy monitoring URLs redirect to FinOps pages.
The worker schedules only `FINOPS_SOURCE_IDS`; historical monitoring data stays
readable in storage but is not collected or shown as product functionality.
