// Interface web du répondant : HTML rendu côté serveur, sans JavaScript client.
import express, { Router } from "express";
import { ANSWER_MAX, type Answer, type Db, type Session } from "./db.ts";

export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; color: #222; }
    h1 { font-size: 1.4rem; white-space: pre-wrap; }
    .meta { color: #666; font-size: .85rem; }
    textarea { width: 100%; min-height: 8rem; font: inherit; padding: .5rem; box-sizing: border-box; }
    button { font: inherit; padding: .5rem 1.2rem; margin-top: .5rem; cursor: pointer; }
    ol { padding-left: 1.2rem; }
    li { margin-bottom: 1rem; }
    li p { margin: 0; white-space: pre-wrap; }
    .closed { background: #f3f3f3; padding: .75rem 1rem; border-radius: 6px; }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

function sessionPage(session: Session, answers: Answer[], error?: string): string {
  const list = answers.length
    ? `<ol>${answers
        .map(
          (a) =>
            `<li><p>${escapeHtml(a.text)}</p><span class="meta">${escapeHtml(a.created_at)}</span></li>`,
        )
        .join("")}</ol>`
    : `<p class="meta">Aucune réponse pour le moment.</p>`;

  const form =
    session.status === "open"
      ? `<form method="post" action="/s/${session.id}/answers">
  <label for="text">Votre réponse</label>
  <textarea id="text" name="text" required maxlength="${ANSWER_MAX}"></textarea>
  ${error ? `<p role="alert">${escapeHtml(error)}</p>` : ""}
  <button type="submit">Envoyer</button>
</form>`
      : `<p class="closed">Cette session est close : elle n'accepte plus de réponses.</p>`;

  return layout(
    "Question",
    `<p class="meta">Question posée par un agent</p>
<h1>${escapeHtml(session.question)}</h1>
${form}
<h2>Réponses (${answers.length})</h2>
${list}`,
  );
}

export function webRouter(db: Db): Router {
  const router = Router();
  router.use(express.urlencoded({ extended: false }));

  router.get("/s/:id", (req, res) => {
    const session = db.getSession(req.params.id);
    if (!session) {
      res.status(404).send(layout("Introuvable", "<h1>Session introuvable</h1>"));
      return;
    }
    res.send(sessionPage(session, db.listAnswers(session.id)));
  });

  router.post("/s/:id/answers", (req, res) => {
    const session = db.getSession(req.params.id);
    if (!session) {
      res.status(404).send(layout("Introuvable", "<h1>Session introuvable</h1>"));
      return;
    }
    if (session.status !== "open") {
      res.status(409).send(sessionPage(session, db.listAnswers(session.id)));
      return;
    }
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text || text.length > ANSWER_MAX) {
      const error = `La réponse doit faire entre 1 et ${ANSWER_MAX} caractères.`;
      res.status(400).send(sessionPage(session, db.listAnswers(session.id), error));
      return;
    }
    db.addAnswer(session.id, text);
    res.redirect(303, `/s/${session.id}`);
  });

  return router;
}
