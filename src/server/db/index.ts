import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Postgres NOTICE messages (e.g. 42P07 "already exists") are not errors. Swallow
// them so they never surface as log noise.
pool.on("connect", (client) => {
  client.on("notice", () => {});
});

export const db = drizzle(pool, { schema });
export type DB = typeof db;
export { pool };
