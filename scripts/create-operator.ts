import { provisionOperator, validateOperatorInput } from "../src/server/auth/provision-operator";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  const options: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    const match = /^--(email|name)=(.*)$/.exec(arg);
    if (!match)
      throw new Error("Use --email=<email> and --name=<name>; supply the password on stdin.");
    options[match[1]!] = match[2]!;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of Bun.stdin.stream()) {
    size += chunk.byteLength;
    if (size > 4096) throw new Error("Password input is too large.");
    chunks.push(chunk);
  }
  const password = Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
  const input = validateOperatorInput({
    email: options.email ?? "",
    name: options.name ?? "Operator",
    password,
  });
  const { db, pool } = await import("../src/server/db");
  try {
    await provisionOperator(db, input);
    console.info("Operator account created. Public registration remains disabled.");
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  console.error(
    "Operator creation failed. Check the database, input requirements, and whether the account already exists.",
  );
  process.exitCode = 1;
});
