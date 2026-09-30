import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The worker runs straight from source with Bun (`bun run src/worker/index.ts`)
 * and the runtime image does not ship tsconfig.json, so the `@/` path alias
 * cannot be resolved there. It resolves fine in the Vite build and in tests,
 * which is why this only ever fails in production, as a crash loop. Server and
 * worker code therefore import by relative path.
 */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith(".ts") || full.endsWith(".tsx") ? [full] : [];
  });
}

describe("server and worker imports", () => {
  it("never use the @/ path alias", () => {
    const offenders = ["src/server", "src/worker"]
      .flatMap((dir) => sourceFiles(dir))
      .filter((file) => /from\s+"@\//.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
});
