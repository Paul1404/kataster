# Kataster

Kataster connects an infrastructure inventory with customer ownership, provider
costs, contracts, and billing. It is built for a small hosting operation: domains,
DNS, mail, hosts, containers, cloud projects, and certificates in one register.

Connectors discover and enrich resources. The operator can see who owns them,
what they cost, which checks need attention, and whether a customer is ready to
be invoiced. The interface is German. The name comes from the German land
register; `LFIO_` environment variables retain the former product's compatibility
prefix.

[MIT licensed](LICENSE). Public source, private deployments. This repository
contains no production inventory, customer database, or provider credentials.
See [the publication boundary](docs/publication.md).

## Stack

TanStack Start (Vite) + Router + Query + Form, Tailwind v4 + shadcn/ui, oRPC, better-auth, Drizzle ORM + PostgreSQL, BullMQ + Redis, Bun. Biome + Vitest. Deployed on Railway.

## How it works

- **Connectors** run health checks. A connector is one file under `src/server/connectors/` that declares a config schema and a `check()` function. The HTTP connector ships built; AWS Route 53 is the first credentialed example.
- **Connections** hold encrypted credentials (AES-256-GCM). Configure an API key once, reference it from many assets.
- **Resources** are Configuration Items with an owner, a lifecycle status, and an audit trail. Connectors discover and enrich them; nothing is deleted, stale objects are decommissioned.
- **Customers** are CRM records with contacts, billing fields, and contract positions. Cost is attributed per resource and compared with what each customer pays.
- A **worker** process runs scheduled checks via BullMQ and writes results to Postgres.

## Run locally

Requires Bun, a PostgreSQL database, and Redis.

```sh
bun install
cp .env.example .env        # fill in DATABASE_URL, REDIS_URL, secrets
bun run icons               # generate the favicon set
bun run db:migrate:prod     # apply the committed migrations
bun run dev                 # web app on http://localhost:3000
bun run worker              # background check worker (separate terminal)
```

Public registration is disabled. Provision a trusted operator from a terminal
using the same `DATABASE_URL`, with a password of 12 to 128 characters supplied
on stdin:

```sh
bash -c 'read -rsp "Operator password: " taskPassword; printf "%s" "$taskPassword"' \
  | bun run user:create --email=operator@example.com --name='Operator'
```

The command creates a new account transactionally and refuses to overwrite an
existing account. It never prints the password. Every provisioned operator can
access the entire register: this is a single-organization tool, not a customer
portal with tenant isolation. Provision accounts only for trusted operators.

## Environment

See `.env.example`. `LFIO_ENCRYPTION_KEY` must be a stable 32-byte base64 key. AWS and other API credentials are never set via env. They are configured in the app and stored encrypted.

## MCP endpoint

`POST /api/mcp` is a stateless MCP (Model Context Protocol) server for inventory, customers, margin, billing readiness, and incidents. Tokens are read-only by default. Write-scoped tokens can assign resource owners and change pricing or provider costs, with every write attempt recorded in the MCP audit log.

Generate a token in the app under **Settings → MCP access tokens** (shown once), then connect:

```sh
claude mcp add kataster --transport http https://<your-app>/api/mcp \
  --header "Authorization: Bearer <token>"
```

`LFIO_MCP_TOKEN` still works as an optional read-only env fallback. Set `LFIO_MCP_ENV_ACCESS=write` only when that token requires mutation tools. Tools: `overview`, `list_customers`, `list_resources`, `margin_summary`, `billing_readiness`, `customer_statements`, `list_contract_positions`, `list_incidents`, `assign_resource_owner`, `apply_owner_suggestions`, `upsert_contract_position`, `set_customer_price` (one-off adjustment), `upsert_provider_cost`.

## Deploy

Railway, via the multi-stage `Dockerfile`. The app and worker run the same image with different start commands. Postgres and Redis are Railway services wired in with reference variables. Per-service start, migration, and healthcheck settings are configured in Railway because the shared image has different web and worker requirements.

The web service runs `bun run server.ts`, migrates with
`bun run db:migrate:prod` before deployment, and uses `/api/health`. The worker
runs `bun run src/worker/index.ts`. Preserve existing database volumes and the
encryption key during upgrades; replacing the key makes stored credentials
unreadable.

## Tests

```sh
bun run test
```

For a complete source check, build first to generate the route tree, then run
`bun run lint`, `bun run typecheck`, `bun run test`, and `bunx drizzle-kit check`.
CI also builds the production Docker image and scans Git history for secrets.
