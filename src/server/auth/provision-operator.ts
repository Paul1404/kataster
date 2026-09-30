import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import type { DB } from "../db";
import { accounts, users } from "../db/schema/auth";

export interface OperatorInput {
  email: string;
  name: string;
  password: string;
}

export function validateOperatorInput(input: OperatorInput): OperatorInput {
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("A valid operator email is required.");
  }
  if (!name || name.length > 100) throw new Error("A name of 1 to 100 characters is required.");
  if (input.password.length < 12 || input.password.length > 128) {
    throw new Error("The password must contain 12 to 128 characters.");
  }
  return { email, name, password: input.password };
}

/** Trusted terminal only. Never expose this through an HTTP or MCP endpoint. */
export async function provisionOperator(database: DB, raw: OperatorInput): Promise<void> {
  const input = validateOperatorInput(raw);
  const passwordHash = await hashPassword(input.password);
  await database.transaction(async (tx) => {
    const existing = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, input.email));
    if (existing.length) throw new Error("An account with this email already exists.");
    const id = randomUUID();
    await tx.insert(users).values({ id, name: input.name, email: input.email });
    await tx.insert(accounts).values({
      id: randomUUID(),
      userId: id,
      accountId: id,
      providerId: "credential",
      password: passwordHash,
    });
  });
}
