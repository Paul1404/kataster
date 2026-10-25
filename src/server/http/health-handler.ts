export function createHealthHandler(check: () => Promise<unknown>) {
  return async (): Promise<Response> => {
    try {
      await check();
      return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
    } catch {
      return Response.json(
        { status: "unavailable" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
  };
}

export const handleHealthRequest = createHealthHandler(async () => {
  const { checkDependencies } = await import("./readiness");
  await checkDependencies();
});
