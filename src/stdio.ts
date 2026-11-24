// Point d'entrée stdio, lancé directement par le client MCP (Claude Desktop, Claude Code…).
// Le même process parle MCP sur stdin/stdout et sert les pages du quiz en HTTP.
// Si le port est déjà occupé par une autre instance quiz-runner (npm start, autre conversation),
// on ne sert que le MCP : les deux process partagent la même base SQLite, l'autre sert les pages.
// Rien ne doit être écrit sur stdout en dehors du protocole : les logs vont sur stderr.
import type { Server } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openDb } from "./db.ts";
import { buildMcpServer } from "./mcp.ts";
import { configFromEnv, createWebApp, listen } from "./server.ts";

const log = (...args: unknown[]) => console.error("quiz-runner:", ...args);

const config = configFromEnv();
const db = openDb(config.dbPath);

let web: Server | undefined;
let retry: NodeJS.Timeout | undefined;

// Sert les pages si le port est libre ; sinon réessaie régulièrement pour prendre le relais
// quand l'instance qui les sert s'arrête.
async function serveWeb(firstTry: boolean) {
  try {
    web = await listen(createWebApp(db, config, { withMcp: false }), config.port, config.host);
    clearInterval(retry);
    log(`pages du quiz sur ${config.publicUrl}/q/<id>`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    if (!firstTry) return;
    const owner = await fetch(`${config.publicUrl}/healthz`)
      .then((r) => r.json() as Promise<{ name?: string }>)
      .catch(() => undefined);
    if (owner?.name === "quiz-runner") {
      log(`port ${config.port} déjà servi par une autre instance quiz-runner : elle affiche les pages`);
    } else {
      log(`port ${config.port} occupé par un autre programme : les URL des quiz ne fonctionneront pas (change PORT)`);
    }
    retry = setInterval(() => void serveWeb(false).catch(log), 5000);
    retry.unref();
  }
}
await serveWeb(true);

const server = buildMcpServer(db, config.publicUrl);
const transport = new StdioServerTransport();

// Le client ferme stdin quand il arrête le serveur : on libère le port et la base.
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(retry);
  web?.close();
  web?.closeAllConnections();
  void server.close();
  db.close();
  process.exit(0);
}
transport.onclose = shutdown;
process.stdin.on("end", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await server.connect(transport);
log(`MCP sur stdio, base ${config.dbPath}`);
