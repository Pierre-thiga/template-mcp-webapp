// Interface web du répondant : coquille HTML rendue côté serveur + JS vanilla (public/quiz.js).
import { Router, type Response } from "express";
import { z } from "zod";
import { CONFIDENCE_LEVELS, LIMITS, letterFor, type Db, type QuizDoc } from "./db.ts";

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// JSON sûr dans un <script> : rien ne peut fermer la balise ni ouvrir un commentaire HTML.
function scriptJson(data: unknown): string {
  return JSON.stringify(data)
    .replaceAll("<", "\\u003c")
    .replaceAll(" ", "\\u2028")
    .replaceAll(" ", "\\u2029");
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/quiz.css">
</head>
<body>
${body}
</body>
</html>`;
}

function notFoundPage(): string {
  return layout("Quiz not found", `<main class="notice"><h1>Quiz not found</h1><p>Check the link you were given.</p></main>`);
}

function quizPage(doc: QuizDoc): string {
  const data = { quiz: doc, server_now: new Date().toISOString(), comment_max: LIMITS.comment };
  return layout(
    doc.name,
    `<noscript><p class="notice">This quiz needs JavaScript.</p></noscript>
<div id="app" aria-live="polite"></div>
<script type="application/json" id="quiz-data">${scriptJson(data)}</script>
<script src="/quiz.js" defer></script>`,
  );
}

function patchSchema(choiceCount: number) {
  const letters = Array.from({ length: choiceCount }, (_, i) => letterFor(i));
  const letter = z.string().refine((l) => letters.includes(l), "unknown option");
  return z
    .object({
      selected: letter.nullable(),
      struck: z.array(letter).max(choiceCount).refine((a) => new Set(a).size === a.length, "duplicates"),
      bookmarked: z.boolean(),
      confidence: z.enum(CONFIDENCE_LEVELS).nullable(),
      comment: z.string().max(LIMITS.comment),
    })
    .partial()
    .strict();
}

export function webRouter(db: Db): Router {
  const router = Router();

  // Renvoie le quiz s'il accepte encore des modifications, sinon répond 404 / 409.
  function openQuiz(id: string, res: Response): QuizDoc | undefined {
    const doc = db.getById(id);
    if (!doc) res.status(404).json({ error: "Quiz not found" });
    else if (doc.status !== "open") res.status(409).json({ error: `Quiz is ${doc.status}`, status: doc.status });
    else return doc;
  }

  router.get("/q/:id", (req, res) => {
    const doc = db.markStarted(req.params.id);
    if (!doc) {
      res.status(404).send(notFoundPage());
      return;
    }
    res.set("Cache-Control", "no-store").send(quizPage(doc));
  });

  router.put("/q/:id/responses/:number", (req, res) => {
    const doc = openQuiz(req.params.id, res);
    if (!doc) return;
    const number = Number(req.params.number);
    const question = Number.isInteger(number) ? doc.questions[number - 1] : undefined;
    if (!question) {
      res.status(400).json({ error: "Unknown question number" });
      return;
    }
    const parsed = patchSchema(question.choices.length).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid response", issues: parsed.error.issues });
      return;
    }
    const updated = db.patchResponse(doc.id, number, parsed.data);
    if (!updated || updated.status !== "open") {
      res.status(409).json({ error: "Quiz is no longer open", status: updated?.status });
      return;
    }
    res.json({ response: updated.questions[number - 1]!.response });
  });

  router.post("/q/:id/submit", (req, res) => {
    const doc = openQuiz(req.params.id, res);
    if (!doc) return;
    const updated = db.submit(doc.id)!;
    res.json({ status: updated.status, submitted_at: updated.submitted_at });
  });

  return router;
}
