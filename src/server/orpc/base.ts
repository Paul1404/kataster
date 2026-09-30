import { ORPCError, os } from "@orpc/server";
import { auth } from "../auth";

export interface BaseContext {
  headers: Headers;
}

export const pub = os.$context<BaseContext>();

// Every domain procedure builds on `authed`. Auth is enforced here, server-side,
// never via route guards alone. Single org: any logged-in user sees everything.
export const authed = pub.use(async ({ context, next }) => {
  const session = await auth.api.getSession({ headers: context.headers });
  if (!session) {
    throw new ORPCError("UNAUTHORIZED", { message: "Sign in required" });
  }
  return next({
    context: {
      ...context,
      user: session.user,
      session: session.session,
    },
  });
});
