import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 3_000,
  query_timeout: 2_000,
});

// Idle connections can close during database restarts. Keep readiness available
// so it returns 503 and lets the pool reconnect on the next request.
pool.on("error", () => {
  console.warn("[database] idle connection closed; reconnecting on the next request");
});

// Postgres NOTICE messages (e.g. 42P07 "already exists") are not errors. Swallow
// them so they never surface as log noise.
pool.on("connect", (client) => {
  client.on("notice", () => {});
});

export const db = drizzle(pool, { schema });
export type DB = typeof db;
export { pool };
