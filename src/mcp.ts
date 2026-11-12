// API MCP exposée à l'agent : 3 outils, en Streamable HTTP stateless.
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { QUESTION_MAX, type Db } from "./db.ts";

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function notFound(sessionId: string) {
  return {
    content: [{ type: "text" as const, text: `Session inconnue : ${sessionId}` }],
    isError: true,
  };
}

export function buildMcpServer(db: Db, publicUrl: string): McpServer {
  const server = new McpServer({ name: "ask-human", version: "0.1.0" });

  server.registerTool(
    "ask_question",
    {
      title: "Poser une question à un humain",
      description:
        "Crée une session contenant une question en texte libre et renvoie l'URL de la page web où un humain peut y répondre. " +
        "Transmets cette URL à l'utilisateur, puis appelle get_answers plus tard pour lire les réponses.",
      inputSchema: { question: z.string().trim().min(1).max(QUESTION_MAX) },
    },
    async ({ question }) => {
      const session = db.createSession(question);
      return json({
        session_id: session.id,
        url: `${publicUrl}/s/${session.id}`,
        status: session.status,
      });
    },
  );

  server.registerTool(
    "get_answers",
    {
      title: "Lire les réponses",
      description:
        "Renvoie la question, le statut de la session et toutes les réponses reçues jusqu'ici (liste vide s'il n'y en a pas encore).",
      inputSchema: { session_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ session_id }) => {
      const session = db.getSession(session_id);
      if (!session) return notFound(session_id);
      return json({
        session_id: session.id,
        question: session.question,
        status: session.status,
        answers: db.listAnswers(session.id),
      });
    },
  );

  server.registerTool(
    "close_session",
    {
      title: "Clore la session",
      description: "Ferme la session : la page web n'accepte plus de nouvelles réponses.",
      inputSchema: { session_id: z.string() },
      annotations: { idempotentHint: true },
    },
    async ({ session_id }) => {
      if (!db.getSession(session_id)) return notFound(session_id);
      db.closeSession(session_id);
      return json({ session_id, status: "closed" });
    },
  );

  return server;
}

// Mode stateless : un serveur + un transport neufs par requête, tout l'état est dans SQLite.
export function mcpHandler(db: Db, publicUrl: string) {
  return async (req: Request, res: Response) => {
    const server = buildMcpServer(db, publicUrl);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("Erreur MCP :", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  };
}
