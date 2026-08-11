import { buildServer } from "./api.js";
import { EventHub } from "./events.js";
import { JobStore } from "./store.js";

const host = "127.0.0.1";
const port = Number(process.env.PORT ?? 17321);
const events = new EventHub();
const store = new JobStore(undefined, events);
await store.init();
const app = await buildServer(store, events);
let shuttingDown = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void shutdown());
}

await app.listen({ host, port });

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  // Fastify waits for SSE clients to disconnect. Let clients finish briefly,
  // then close lingering sockets so the background process can actually exit.
  const forceCloseTimer = setTimeout(() => app.server.closeAllConnections(), 2_000);
  forceCloseTimer.unref();
  try {
    await app.close();
  } finally {
    clearTimeout(forceCloseTimer);
    store.close();
    process.exit(0);
  }
}
