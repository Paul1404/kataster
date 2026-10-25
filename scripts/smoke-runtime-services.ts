export {};

// Exercise both real service entry points against disposable CI dependencies.
const database = new URL(process.env.DATABASE_URL ?? "");
if (database.hostname !== "127.0.0.1" || database.pathname !== "/kataster_runtime_test") {
  throw new Error("Runtime smoke checks require the isolated local CI database");
}

for (const entry of ["server.ts", "src/worker/index.ts"]) {
  const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = reservation.port;
  await reservation.stop(true);
  const child = Bun.spawn([process.execPath, "--smol", entry], {
    env: { ...process.env, PORT: String(port) },
    stdout: "inherit",
    stderr: "inherit",
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`${entry} exited before readiness`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
          signal: AbortSignal.timeout(2000),
        });
        if (response.status === 200) {
          ready = true;
          break;
        }
      } catch {
        // Wait for the real process to bind and connect to the disposable data services.
      }
      await Bun.sleep(300);
    }
    if (!ready) throw new Error(`${entry} did not become healthy`);
    console.log(`Production image entry point passed: ${entry}`);
  } finally {
    child.kill("SIGTERM");
    await Promise.race([child.exited, Bun.sleep(5000)]);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
}
