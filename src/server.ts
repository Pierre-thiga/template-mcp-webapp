// Point d'entrée : un seul process Express qui sert l'API MCP (/mcp) et l'interface web (/s/:id).
import type { Server } from "node:http";
import { pathToFileURL } from "node:url";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { openDb } from "./db.ts";
import { mcpHandler } from "./mcp.ts";
import { webRouter } from "./web.ts";

export interface Config {
  port: number;
  host: string;
  publicUrl: string;
  dbPath: string;
}

export function start(config: Config): Promise<{ server: Server; close: () => void }> {
  const db = openDb(config.dbPath);
  // Inclut express.json() et la protection DNS rebinding quand on écoute sur localhost.
  const app = createMcpExpressApp({ host: config.host });

  app.post("/mcp", mcpHandler(db, config.publicUrl));
  app.all("/mcp", (_req, res) => {
    res.status(405).set("Allow", "POST").send("Method Not Allowed");
  });
  app.use(webRouter(db));

  return new Promise((resolve) => {
    const server = app.listen(config.port, config.host, () => {
      resolve({
        server,
        close: () => {
          server.close();
          db.close();
        },
      });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.PORT ?? 3000);
  const config: Config = {
    port,
    host: process.env.HOST ?? "127.0.0.1",
    publicUrl: (process.env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ""),
    dbPath: process.env.DB_PATH ?? "./data.db",
  };
  await start(config);
  console.log(`Ask Human : MCP sur ${config.publicUrl}/mcp, pages sur ${config.publicUrl}/s/<id>`);
}
