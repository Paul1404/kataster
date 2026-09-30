export function handleHealthRequest(): Response {
  return Response.json({ status: "ok" });
}
