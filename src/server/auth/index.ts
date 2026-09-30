import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { db } from "../db";
import { accounts, sessions, users, verifications } from "../db/schema";

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    usePlural: true,
    // With usePlural, the schema mapping keys must also be plural.
    schema: { users, sessions, accounts, verifications },
  }),
  emailAndPassword: {
    enabled: true,
    // Single-org tool: no email verification step required. Sign-up is DISABLED
    // because auth is the only gate (any logged-in user sees everything), so open
    // registration = full public access. Provision accounts out-of-band.
    requireEmailVerification: false,
    disableSignUp: true,
  },
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // refresh daily
  },
  // tanstackStartCookies must be the LAST plugin.
  plugins: [tanstackStartCookies()],
});

export type Session = typeof auth.$Infer.Session;
