// API MCP exposée à l'agent : 3 outils, en Streamable HTTP stateless.
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { DuplicateRunIdError, LIMITS, timing, type Db, type QuizDoc } from "./db.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function error(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

function notFound(runId: string) {
  return error(`Unknown run_id: ${runId}`);
}

function results(doc: QuizDoc) {
  const responses = doc.questions.map((q) => ({
    number: q.number,
    selected: q.response.selected,
    struck: q.response.struck,
    bookmarked: q.response.bookmarked,
    confidence: q.response.confidence,
    comment: q.response.comment,
  }));
  return {
    run_id: doc.run_id,
    name: doc.name,
    status: doc.status,
    started_at: doc.started_at,
    submitted_at: doc.submitted_at,
    time_limit_seconds: doc.time_limit_seconds,
    ...timing(doc),
    question_count: doc.questions.length,
    answered_count: responses.filter((r) => r.selected !== null).length,
    responses,
  };
}

const questionSchema = z.object({
  text: z.string().trim().min(1).max(LIMITS.questionText).describe("Question text (plain text, line breaks kept)."),
  choices: z
    .array(z.string().trim().min(1).max(LIMITS.choiceText))
    .min(LIMITS.choicesMin)
    .max(LIMITS.choicesMax)
    .describe("Answer options, in display order. They are labelled A, B, C… automatically: do not prefix them."),
});

export function buildMcpServer(db: Db, publicUrl: string): McpServer {
  const server = new McpServer({ name: "quiz-runner", version });

  server.registerTool(
    "create_quiz",
    {
      title: "Create a single-choice quiz",
      description:
        "Creates a single-choice quiz (exactly one correct option per question) that a human takes in a web page, and returns its URL. " +
        "Questions are numbered 1..N and options lettered A, B, C… in the order given. " +
        "Do NOT send the correct answers: the server never stores them; keep them yourself and grade the quiz after reading the results. " +
        "Give the URL to the user, without revealing the answers, then call get_quiz_results once they say they are done. " +
        "The timer starts when the page is first opened; going over time is allowed and reported.",
      inputSchema: {
        run_id: z
          .string()
          .trim()
          .min(1)
          .max(LIMITS.runId)
          .describe("Your unique identifier for this quiz run, reused in the other tools. Must not already exist."),
        name: z.string().trim().min(1).max(LIMITS.name).describe("Quiz title shown to the user."),
        time_limit_minutes: z
          .number()
          .int()
          .min(1)
          .max(LIMITS.timeLimitMinutesMax)
          .optional()
          .describe("Time allotted, in minutes. Omit for no limit (the page then shows elapsed time)."),
        questions: z.array(questionSchema).min(LIMITS.questionsMin).max(LIMITS.questionsMax),
      },
    },
    async ({ run_id, name, time_limit_minutes, questions }) => {
      try {
        const doc = db.createQuiz({
          run_id,
          name,
          time_limit_seconds: time_limit_minutes ? time_limit_minutes * 60 : null,
          questions,
        });
        return json({
          quiz_id: doc.id,
          run_id: doc.run_id,
          url: `${publicUrl}/q/${doc.id}`,
          question_count: doc.questions.length,
          time_limit_minutes: time_limit_minutes ?? null,
          status: doc.status,
        });
      } catch (err) {
        if (err instanceof DuplicateRunIdError) return error(`run_id already exists: ${run_id}`);
        throw err;
      }
    },
  );

  server.registerTool(
    "get_quiz_results",
    {
      title: "Read quiz results",
      description:
        "Returns the quiz status and, for each question number, the selected letter (null if unanswered), struck-out letters, " +
        "bookmark flag, confidence (low/medium/high/null) and comment, plus timing. " +
        "status 'submitted' means the user validated their answers; 'open' means they may still be working (answers are autosaved). " +
        "Struck-out options do not count as answers.",
      inputSchema: { run_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ run_id }) => {
      const doc = db.getByRunId(run_id);
      return doc ? json(results(doc)) : notFound(run_id);
    },
  );

  server.registerTool(
    "close_quiz",
    {
      title: "Close the quiz",
      description:
        "Locks the quiz: the page becomes read-only and no longer accepts changes. No effect if it was already submitted or closed.",
      inputSchema: { run_id: z.string() },
      annotations: { idempotentHint: true },
    },
    async ({ run_id }) => {
      const doc = db.getByRunId(run_id);
      if (!doc) return notFound(run_id);
      const updated = db.closeQuiz(doc.id) ?? doc;
      return json({ run_id, status: updated.status });
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
