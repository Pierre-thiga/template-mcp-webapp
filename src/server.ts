// Point d'entrée HTTP : un seul process Express qui sert l'API MCP (/mcp) et l'interface web (/q/:id).
// src/stdio.ts réutilise createWebApp() pour servir les pages tout en parlant MCP sur stdio.
import { createServer, type Server } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import express, { type Express } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { openDb, type Db } from "./db.ts";
import { mcpHandler } from "./mcp.ts";
import { webRouter } from "./web.ts";

export interface Config {
  port: number;
  host: string;
  publicUrl: string;
  dbPath: string;
}

// Base à la racine du projet, quel que soit le dossier courant : les modes HTTP et stdio partagent les mêmes données.
const DEFAULT_DB_PATH = fileURLToPath(new URL("../data.db", import.meta.url));

export function configFromEnv(env = process.env): Config {
  const port = Number(env.PORT ?? 3000);
  return {
    port,
    host: env.HOST ?? "127.0.0.1",
    publicUrl: (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ""),
    dbPath: env.DB_PATH ?? DEFAULT_DB_PATH,
  };
}

export function createWebApp(db: Db, config: Config, { withMcp = true } = {}): Express {
  // Inclut express.json() et la protection DNS rebinding quand on écoute sur localhost.
  const app = createMcpExpressApp({ host: config.host });
  if (withMcp) {
    app.post("/mcp", mcpHandler(db, config.publicUrl));
    app.all("/mcp", (_req, res) => {
      res.status(405).set("Allow", "POST").send("Method Not Allowed");
    });
  }
  app.get("/healthz", (_req, res) => {
    res.json({ name: "quiz-runner" });
  });
  app.use(express.static(fileURLToPath(new URL("../public", import.meta.url))));
  app.use(webRouter(db));
  return app;
}

// Rejette (au lieu de planter le process) si le port est déjà pris.
export function listen(app: Express, port: number, host: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

export async function start(config: Config): Promise<{ server: Server; close: () => void }> {
  const db = openDb(config.dbPath);
  try {
    const server = await listen(createWebApp(db, config), config.port, config.host);
    return {
      server,
      close: () => {
        server.close();
        db.close();
      },
    };
  } catch (err) {
    db.close();
    throw err;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const config = configFromEnv();
  await start(config);
  console.log(`quiz-runner : MCP sur ${config.publicUrl}/mcp, quiz sur ${config.publicUrl}/q/<id>`);
}
