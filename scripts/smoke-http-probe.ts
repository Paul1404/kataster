// Exercise real Bun fetch cancellation against a local endless response.
import * as v from "valibot";
import { httpConnector } from "../src/server/connectors/http/http.connector";

let cancelled = 0;
let chunks = 0;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch() {
    let timer: ReturnType<typeof setInterval>;
    return new Response(
      new ReadableStream({
        start(controller) {
          timer = setInterval(() => {
            chunks++;
            controller.enqueue(new Uint8Array(16384));
          }, 10);
        },
        cancel() {
          clearInterval(timer);
          cancelled++;
        },
      }),
    );
  },
});
try {
  const config = v.parse(httpConnector.configSchema, { checkCertificate: false });
  for (let i = 0; i < 10; i++) {
    const result = await httpConnector.check(
      server.url.toString(),
      config,
      {},
      { signal: AbortSignal.timeout(2000), now: new Date() },
    );
    if (result.status !== "up") throw new Error("Probe changed status");
  }
  const deadline = Date.now() + 2000;
  while (cancelled < 10 && Date.now() < deadline) await Bun.sleep(10);
  if (cancelled !== 10) throw new Error(`Only ${cancelled}/10 streams closed`);
  if (chunks > 100) throw new Error(`Probes kept downloading: ${chunks} chunks`);
  console.log(JSON.stringify({ runtime: Bun.version, probes: 10, cancelled, chunks }));
} finally {
  await server.stop(true);
}
