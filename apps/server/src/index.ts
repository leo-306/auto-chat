import { buildServer } from "./api.js";
import { EventHub } from "./events.js";
import { JobStore } from "./store.js";

const host = "127.0.0.1";
const port = Number(process.env.PORT ?? 17321);
const events = new EventHub();
const store = new JobStore(undefined, events);
await store.init();
const app = await buildServer(store, events);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    store.close();
    process.exit(0);
  });
}

await app.listen({ host, port });
