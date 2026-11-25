import { app } from "@azure/functions";
import { BlobServiceClient } from "@azure/storage-blob";
import { blobStore, makeEnv, handle, sync } from "./core.js";

const container = BlobServiceClient.fromConnectionString(process.env.AzureWebJobsStorage).getContainerClient(process.env.PANEL_CONTAINER || "panelkv");
const env = makeEnv(blobStore(container));

app.http("panel", {
  route: "{*path}",
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    try {
      const body = ["GET", "HEAD"].includes(req.method) ? null : Buffer.from(await req.arrayBuffer());
      return await handle(env, req.method, req.url, req.headers, body);
    } catch (e) { ctx.error("panel error", e); return { status: 500, jsonBody: { error: "Something went wrong." } }; }
  }
});

app.timer("snapSync", {
  schedule: "0 */5 * * * *",
  handler: async (t, ctx) => { await sync(env, (...a) => ctx.log(...a)).catch(e => ctx.error("sync failed", e)); }
});
