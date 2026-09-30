import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { auth } from "./index";

// Server function usable from route beforeLoad (SSR and client navigation).
// Returns the better-auth session or null.
export const fetchSession = createServerFn({ method: "GET" }).handler(async () => {
  const headers = new Headers(getRequestHeaders() as HeadersInit);
  const session = await auth.api.getSession({ headers });
  if (!session) return null;
  return {
    user: { id: session.user.id, name: session.user.name, email: session.user.email },
  };
});
