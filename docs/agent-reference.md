# Detailed agent reference

This file preserves the previous repository guidance during the 2026-08-08
instruction standardization. The canonical entry point is `../AGENTS.md`.
Consult this file for project-specific detail and known gotchas. Verify generic
version and tooling statements against the current repository before applying
them.

# CLAUDE.md

## Meta -- How to treat this file

This file is a living document. It contains rules, gotchas, and stack decisions accumulated across many projects and real production failures.

When you read this file and encounter anything that is:
- Outdated or contradicted by current library versions
- Incorrect based on what you observe in the actual project
- Missing something important you discovered during your work
- Ambiguous or unclear

**You are expected to propose an update.** At the end of your work session, if you found anything worth changing, output a clearly marked section:

```
## Suggested CLAUDE.md Updates

### [Section name]
**Reason**: what you found / why this is wrong or missing
**Proposed change**: the exact text to add, remove, or replace
```

Do not silently work around wrong guidance. Surface it so the next agent starts with better information.

---

## Before Starting Any Task

Before writing any code or installing any package, always fetch the latest versions:

**Never assume a version from training data — always look it up first.**

Package versions change constantly. Your training data is outdated. When in doubt:
1. Run `bun info <pkg> version` to get the current latest
2. Use `latest` tag only if no specific version is needed
3. Check the package's GitHub releases or changelog if behavior seems off

This applies especially to:
- `@tanstack/react-start`, `@tanstack/react-router` — release frequently
- `better-auth` — actively developed, breaking changes possible
- `drizzle-orm`, `drizzle-kit` — v1 beta, changes often
- `@orpc/server`, `@orpc/client` — newer library, evolving fast
- `valibot` — v1 stable but check for updates

## Tech Stack

This project uses the following stack. Always use these tools — never substitute with alternatives unless explicitly instructed.

### Frontend & Framework
- **Framework**: TanStack Start (RC, Vite-based) + TanStack Router (file-based routing)
- **Data Fetching**: TanStack Query v5
- **Styling**: Tailwind CSS v4 + shadcn/ui
- **Forms**: TanStack Form

### Backend
- **API**: oRPC v1 (type-safe RPC + built-in OpenAPI)
- **Auth**: better-auth (with `tanstackStartCookies` plugin)
- **ORM**: Drizzle ORM (v1 beta)
- **Database**: PostgreSQL (Railway)

### Runtime & Tooling
- **Runtime**: Bun (>=1.0)
- **Package Manager**: Bun (no pnpm, no npm, no yarn)
- **Validation**: Valibot (via Drizzle's built-in schema generation)
- **Linting/Formatting**: Biome
- **Testing**: Vitest
- **Deployment**: Railway via Dockerfile

---

## Never Use

Do not use these under any circumstances:
- `prisma` → use Drizzle ORM
- `express` / `fastify` / `nestjs` → use oRPC server routes
- `axios` → use native `fetch`
- `next.js` → use TanStack Start
- `next-auth` / `auth.js` → use better-auth
- `zod` → use Valibot
- `npm` / `yarn` / `pnpm` → use Bun
- `redux` / `zustand` / `jotai` → use TanStack Store or TanStack Query
- `styled-components` / `emotion` / `css modules` → use Tailwind CSS v4
- `react-hook-form` → use TanStack Form
- `app.config.ts` → this is the OLD Vinxi-era config, use `vite.config.ts` instead

---

## Project Structure

---

## Config Files

### vite.config.ts (correct, current setup)

### tsconfig.json (required settings)

> Do NOT enable `verbatimModuleSyntax` — causes server bundle to leak into client bundle.

---

## Critical Rules

### 1. Server/Client Boundary — MOST IMPORTANT

**Drizzle, better-auth server config, and all DB code must NEVER run on the client.**

- All server-only files go in `src/server/` or end with `.server.ts`
- Never import `drizzle-orm`, `pg`, `postgres`, or `better-auth` server config in components
- Use `vite-env-only` to enforce this at build time:

### 2. TanStack Start — Route Structure

Every route file exports a `Route` via `createFileRoute`:

The `__root.tsx` must include `HeadContent` and `Scripts`:

`routeTree.gen.ts` is auto-generated — never edit it manually.

### 3. oRPC Setup

Mount handler via TanStack Start Server Route:

Isomorphic client (works in both SSR and browser):

Define procedures with Valibot:

### 4. Drizzle + Valibot

Drizzle generates Valibot schemas natively — never write them manually:

Drizzle client using postgres Pool (correct for Railway):

### 5. better-auth Setup

**Critical**: always add `tanstackStartCookies()` as the LAST plugin — required for cookie handling in TanStack Start:

Mount handler:

Generate schema after configuring auth (run once):

Browser client:

### 6. Auth in oRPC — Always Protect Server-Side

Never rely on route-level guards alone — every protected oRPC procedure must check auth directly:

---

## Dockerfile (Bun + Railway)

Multi-stage build is required. The runtime stage must always include `node_modules` -- never rely on Bun auto-install in production. Bun auto-install does not resolve peer/optional-peer dependencies correctly (e.g. `kysely` from `@better-auth/kysely-adapter`, `better-call` from `@better-auth/core`).

Required stages:
1. `builder` -- install all deps + build
2. `prod-deps` -- install production-only deps (`bun install --production`)
3. `runner` -- copy `dist/`, `public/`, and `node_modules` from the preceding stages

---

## Migrations

Always use Drizzle Kit — never modify the database directly or push schema to production:

`drizzle.config.ts`:

---

## Environment Variables

### Railway Postgres (auto-injected when Postgres service is connected)

### Railway S3 Bucket (auto-injected when Bucket is connected, style: "AWS SDK Generic")

> Connect services in Railway dashboard via Variable Reference e.g. ${{Postgres.DATABASE_URL}}

### App-specific (set manually in Railway service Variables tab)

---

## Railway Deployment

> **Always check the Railway docs before doing anything deployment-related — they change frequently.**
> Docs: https://docs.railway.com

### What stays stable (you can rely on this)

**Build**: Railway detects a `Dockerfile` automatically and uses it. No Nixpacks, no Railpack — we always use Dockerfile.

**PORT**: Railway injects a `PORT` env var. Your app must listen on it:

**Health endpoint**: Implement `/api/health` and configure that exact path in Railway service settings. Without it, Railway cannot guarantee zero-downtime deploys.

**DATABASE_URL**: Railway Postgres auto-provides this variable. Always use it as-is — never hardcode credentials.

**Internal networking**: Services within the same Railway project communicate via private networking (e.g. `postgres.railway.internal`). Use `${{Postgres.DATABASE_URL}}` reference variables in Railway dashboard to wire services together.

**Config as code** (`railway.toml`): Use this for settings shared by every service built from the repository. Kataster deliberately keeps per-service start commands, migrations, and healthchecks in Railway because its web and worker services share one image but require different settings. Audit those dashboard settings for drift when deployment behavior changes.

### Docs to read before touching these
- Healthchecks: https://docs.railway.com/deployments/healthchecks
- Dockerfile builds: https://docs.railway.com/builds/dockerfiles
- Start command: https://docs.railway.com/deployments/start-command
- Config as code: https://docs.railway.com/config-as-code/reference
- Private networking: https://docs.railway.com/networking/private-networking
- Environment variables: https://docs.railway.com/variables

---

## Known Gotchas

| Issue | Fix |
|---|---|
| `routeTree.gen.ts` opens with errors after rename | Mark as readonly in `.vscode/settings.json` |
| `verbatimModuleSyntax` in tsconfig | Remove it — leaks server code into client bundle |
| `app.config.ts` present in project | Delete it — Vinxi-era, replaced by `vite.config.ts` |
| Drizzle imported in a component | Move all DB logic to `src/server/` and call via oRPC |
| better-auth cookies not being set | Add `tanstackStartCookies()` as last plugin in auth config |
| oRPC missing request headers on SSR | Use `createIsomorphicFn` + pass `getHeaders()` server-side |
| Drizzle adapter table name mismatch | Set `usePlural: true` in drizzle adapter if tables use plural names. When `usePlural: true` is set, the explicit schema mapping keys passed to the adapter must also be plural (e.g. `users`, `sessions`, `accounts`) -- not singular. better-auth transforms the canonical model name to plural before lookup, so singular keys will fail with "model not found in schema object". |
| Build output path wrong | TanStack Start with Vite (`vite.config.ts`) outputs to `dist/client/` and `dist/server/` -- NOT `.output/`. The `.output/` path is the old Nitro-era convention and is wrong for the current Vite-based setup. Dockerfile must copy `dist/` and `public/`, not `.output/`. |
| Bun auto-install in container fails | Never copy only `dist/` + `package.json` into runtime stage -- always include a `prod-deps` stage that runs `bun install --production` and copy its `node_modules` into the runtime image. Bun auto-install does not resolve peer dependencies like `kysely` or `better-call` correctly. |
| Railway deploy stuck | No healthcheck configured — add `/api/health` endpoint and set it in service settings |
| Railway port mismatch | App not listening on `process.env.PORT` — Railway injects PORT, always use it |
| DB connection fails on Railway | Use `${{Postgres.DATABASE_URL}}` reference variable, not hardcoded URL |

---

## Dependabot

Every project must have a `.github/dependabot.yml` configured for the full stack. Always create this file when setting up a new project.

Coverage required:
- `bun` ecosystem -- weekly, Sunday 08:00 Europe/Berlin. Group lockstep packages such as React and TanStack so one lockfile PR cannot introduce version skew.
- `docker` ecosystem (Dockerfile base images) -- weekly, Sunday 08:00 Europe/Berlin

Fetch the latest Dependabot config schema before creating the file: https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference

---

## Documentation References

When in doubt about any tool, fetch the docs before writing code. All docs are LLM-optimized where noted.

| Tool | Docs URL |
|---|---|
| TanStack Start | https://tanstack.com/start/latest/docs |
| TanStack Router | https://tanstack.com/router/latest/docs |
| TanStack Query | https://tanstack.com/query/latest/docs |
| TanStack Form | https://tanstack.com/form/latest/docs |
| oRPC | https://orpc.dev/docs (also: https://orpc.dev/llms.txt for LLM-optimized) |
| better-auth | https://better-auth.com/docs |
| Drizzle ORM | https://orm.drizzle.team/docs |
| Drizzle Kit | https://orm.drizzle.team/docs/kit-overview |
| Valibot | https://valibot.dev/guides/introduction |
| Tailwind CSS v4 | https://tailwindcss.com/docs |
| shadcn/ui | https://ui.shadcn.com/docs |
| Bun | https://bun.sh/docs |
| Biome | https://biomejs.dev/guides/getting-started |
| Vitest | https://vitest.dev/guide |
| Railway | https://docs.railway.com |
| Dependabot | https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference |

---

## Commit Convention

Always use Conventional Commits. No exceptions.

Format: `type(scope): description`

Types: `feat`, `fix`, `chore`, `refactor`, `docs`, `style`, `test`, `perf`

Examples:
- `feat(auth): add google oauth`
- `fix(db): correct migration for users table`
- `chore(deps): update drizzle-orm to latest`

Keep the description lowercase, imperative, no period at the end.

---

## Naming Conventions

- **Files/folders**: kebab-case (`user-profile.ts`, `auth-client.ts`)
- **Components**: PascalCase (`UserProfile.tsx`)
- **Functions/variables**: camelCase (`getUserById`)
- **Database tables**: snake_case plural (`users`, `session_tokens`)
- **Database columns**: snake_case (`created_at`, `user_id`)
- **Environment variables**: SCREAMING_SNAKE_CASE (`DATABASE_URL`)
- **oRPC procedures**: camelCase nested (`users.getById`, `auth.signIn`)
- **Drizzle schema exports**: camelCase for table objects (`users`, `sessionTokens`)

---

## Error Handling

Use oRPC's built-in `ORPCError` for all API errors -- never throw plain `Error` objects from procedures.

Error codes should be descriptive and uppercase: `UNAUTHORIZED`, `NOT_FOUND`, `VALIDATION_FAILED`, `FORBIDDEN`.

On the client side, always handle errors explicitly via TanStack Query's `error` state -- never silently swallow errors.

Log errors server-side via oRPC interceptors, not scattered throughout procedures.

---

## Drizzle Migrations

- `drizzle-kit generate` -- generate migration file from schema changes
- `drizzle-kit migrate` -- apply in production and staging
- `drizzle-kit push` -- development only, never production
- Never edit generated migration files manually
- Never delete migration files
- Commit migration files to git
- Always auto-run migrations on deploy via `preDeployCommand` in `railway.toml` -- never rely on manual `railway run bun run db:migrate` after first deploy. Use a dedicated `db:migrate:prod` script that runs the migrator without drizzle-kit (drizzle-kit is a dev dependency and must not be required at runtime).

---

## .env.example

Every project must have a `.env.example` at the root. Whenever a new environment variable is added, update `.env.example` immediately with the key and a placeholder value or short comment. Never commit real secrets.

---

## README

Every project needs a `README.md`. Write it like a talented engineer wrote it -- no AI fluff, no excessive emojis, no "this project leverages cutting-edge technology". Just:
- What the project does (one sentence)
- How to run it locally
- How to deploy it
- Required environment variables (reference `.env.example`)

Short, direct, useful.

---

## Testing

Write tests that Claude Code can execute directly with `bun test`. Use Vitest.

Focus on:
- Server-side logic (oRPC procedures, auth flows, DB queries)
- Critical business logic
- Not UI components

Always run tests after making changes. If tests fail, fix them before moving on.
---

## UI & Copy Rules

### Text / Copy
- All user-facing copy is German (du-Form, short, direct). Keep product and
  provider names as they are (CloudFront, Mailcow, Railway). Use German
  typographic quotes („…“) inside strings and format numbers via
  `src/lib/format.ts` (1.234,56 €, 12 %, 250 ms, "vor 5 min").
- NO em-dashes, NO en-dashes, NO dashes of any kind used as a parenthetical or pause. This means never write " — " or "—" anywhere in UI copy.
- If you feel like writing an em-dash, stop. Use a period or rewrite the sentence into two.
  - WRONG: "We never store PR data — everything is live from the API."
  - CORRECT: "We never store PR data. Everything comes live from the GitHub API."
- No AI-sounding phrases ("leverage", "seamlessly", "cutting-edge", "robust", "intuitive", "powerful")
- Short, direct, human. Write like a developer wrote it, not a marketing team.

### Icons
- Always use icons instead of emojis -- use lucide-react as the icon library
- No emojis anywhere in the UI, not even as decoration

### Favicon
- Every app must have a full favicon set. Not just one file.
- Required files: `favicon.svg` (primary), `favicon.ico` (legacy 16/32/48), `favicon-16.png`, `favicon-32.png`, `apple-touch-icon.png` (180px), `icon-192.png`, `icon-512.png`, `manifest.webmanifest`
- SVG is the primary source of truth. Generate all PNGs and ICO from it via a `scripts/generate-icons.ts` script using sharp.
- The SVG design should reflect the app purpose. A plain letter on a colored rounded square is acceptable if done cleanly. No generic placeholders.
- Wire all variants into `__root.tsx` head(): SVG first, then PNG 32/16, ICO shortcut, apple-touch, manifest link.
- The `server.ts` wrapper must serve all favicon/icon/manifest files from `dist/client/` with a 1-day cache header -- they will 404 otherwise.

### Design
- Every UI should feel modern, clean, and slightly elegant -- the kind where someone opens it and says "oh this looks good"
- Use shadcn/ui components as the base, customize from there
- Generous whitespace, consistent spacing, clear visual hierarchy
- Dark mode support by default
- Subtle animations where they add polish, never where they distract
- When in doubt: less is more

---

## Logging

### Startup
Keep startup logs minimal and clean. Only log what matters:
- Server listening on which port
- Database migration result (success or failure, not raw SQL notices)
- Any critical config missing

Never log raw Postgres NOTICE messages (42P07, 42P06, etc.) -- these are not errors. Filter them out by setting the pg connection log level or catching and suppressing NOTICE severity before logging.

### General
- Use structured logging with clear severity levels: info, warn, error
- No stack traces for expected conditions (e.g. migration table already exists)
- Errors must include enough context to debug without being verbose
- Never log sensitive values (tokens, passwords, private keys, connection strings)
