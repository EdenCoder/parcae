/**
 * Custom route example — health check endpoint.
 *
 * This file is auto-discovered from the controllers/ directory.
 */

import { route } from "@parcae/backend";

route.get("/v1/health", (_req: any, res: any) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, timestamp: new Date().toISOString() }));
});
