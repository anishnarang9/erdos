import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";

const port = Number(process.env.PORT ?? 8787);
const dbPath = process.env.DB_PATH ?? "ubc26.db"; // *.db is gitignored
const buyerToken = process.env.BUYER_API_TOKEN;
if (!buyerToken) {
  console.error("BUYER_API_TOKEN is required (at least 16 characters)");
  process.exit(1);
}

const { app, close } = createApp({ dbPath, buyerToken });
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[api] listening on http://localhost:${info.port} (db: ${dbPath})`);
});

function shutdown(): void {
  server.close(() => {
    close();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
