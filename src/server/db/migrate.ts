/**
 * Runtime migrator. Applies pending migrations from ./drizzle using drizzle-orm
 * only (no drizzle-kit, which is a dev dependency). Run on deploy via railway.toml
 * preDeployCommand.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("[migrate] DATABASE_URL is not set");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: url });
  pool.on("connect", (client) => {
    client.on("notice", () => {});
  });

  const db = drizzle(pool);
  try {
    await migrate(db, { migrationsFolder: "./drizzle" });
    console.log("[migrate] migrations applied");
  } catch (error) {
    console.error("[migrate] failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
