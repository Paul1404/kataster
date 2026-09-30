# Screenshot demo

The README screenshots come from a local Kataster instance at 1440 x 1000,
using an isolated PostgreSQL database and Redis, with no worker or real
provider connections. They contain only fictional register entries.

`scripts/seed-demo.ts` creates 8 customers, 32 resources, 8 example check
results, one EUR 284 cost pool, and EUR 772 in monthly contract positions.
Cost allocation weights sum to one. Ownership creation is recorded through
the application's history helper. It refuses a nonempty register, remote
database hosts, production mode, and names without the `kataster_demo_` prefix.
It neither clears nor imports existing customer data.

To reproduce, create a disposable database named `kataster_demo_<suffix>` on
localhost, set its `DATABASE_URL` and an isolated `REDIS_URL`, and run:

```sh
bun run db:migrate:prod
bun run demo:seed
# Provision an operator using the terminal-only command in the README.
bun run dev
```

Use only local demo authentication values. Do not copy a production `.env`.
Do not start a worker: `.example.test` targets are fictional, and the demo's
stored check state is synthetic. The operator overview honestly reports the
missing worker and stale checks. Never hide production warnings for a capture.

Capture `/billing`, `/objects`, and `/dashboard` after loading completes,
with reduced motion enabled. Review the images before replacing the README
assets. Demo totals are neither production evidence nor performance benchmarks.
