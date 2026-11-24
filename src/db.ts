// Seule couche d'accès aux données, partagée par l'API MCP et l'interface web.
// Stockage « document » : un quiz = un document JSON dans une table SQLite.
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export type QuizStatus = "open" | "submitted" | "closed";
export type Confidence = "low" | "medium" | "high";
export const CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;

export interface Response {
  selected: string | null;
  struck: string[];
  bookmarked: boolean;
  confidence: Confidence | null;
  comment: string;
  updated_at: string | null;
}

export interface Question {
  number: number;
  text: string;
  choices: { letter: string; text: string }[];
  response: Response;
}

export interface QuizDoc {
  id: string;
  run_id: string;
  name: string;
  time_limit_seconds: number | null;
  status: QuizStatus;
  created_at: string;
  started_at: string | null;
  submitted_at: string | null;
  closed_at: string | null;
  questions: Question[];
}

export interface NewQuiz {
  run_id: string;
  name: string;
  time_limit_seconds: number | null;
  questions: { text: string; choices: string[] }[];
}

export type ResponsePatch = Partial<Omit<Response, "updated_at">>;

export const LIMITS = {
  runId: 100,
  name: 200,
  questionsMin: 1,
  questionsMax: 200,
  choicesMin: 2,
  choicesMax: 26,
  questionText: 5000,
  choiceText: 1000,
  comment: 5000,
  timeLimitMinutesMax: 1440,
} as const;

export class DuplicateRunIdError extends Error {}

export function letterFor(index: number): string {
  return String.fromCharCode(65 + index);
}

export function openDb(path: string) {
  // Plusieurs process peuvent partager la base (serveur HTTP + process stdio lancés par Claude) :
  // WAL + attente sur verrou plutôt qu'une erreur SQLITE_BUSY immédiate.
  const db = new DatabaseSync(path, { timeout: 5000 });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS quizzes (
      id     TEXT PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE,
      doc    TEXT NOT NULL
    );
  `);

  const selectById = db.prepare("SELECT doc FROM quizzes WHERE id = ?");
  const selectByRunId = db.prepare("SELECT doc FROM quizzes WHERE run_id = ?");
  const insert = db.prepare("INSERT INTO quizzes (id, run_id, doc) VALUES (?, ?, ?)");
  const write = db.prepare("UPDATE quizzes SET doc = ? WHERE id = ?");

  function parse(row: unknown): QuizDoc | undefined {
    return row ? (JSON.parse((row as { doc: string }).doc) as QuizDoc) : undefined;
  }

  function getById(id: string): QuizDoc | undefined {
    return parse(selectById.get(id));
  }

  // Lecture + mutation + réécriture atomiques. `mutate` renvoie false pour annuler sans écrire.
  function update(id: string, mutate: (doc: QuizDoc) => boolean | void): QuizDoc | undefined {
    db.exec("BEGIN IMMEDIATE");
    try {
      const doc = getById(id);
      if (!doc || mutate(doc) === false) {
        db.exec("ROLLBACK");
        return doc;
      }
      write.run(JSON.stringify(doc), id);
      db.exec("COMMIT");
      return doc;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  return {
    createQuiz(input: NewQuiz): QuizDoc {
      const doc: QuizDoc = {
        id: randomUUID(),
        run_id: input.run_id,
        name: input.name,
        time_limit_seconds: input.time_limit_seconds,
        status: "open",
        created_at: new Date().toISOString(),
        started_at: null,
        submitted_at: null,
        closed_at: null,
        questions: input.questions.map((q, i) => ({
          number: i + 1,
          text: q.text,
          choices: q.choices.map((text, j) => ({ letter: letterFor(j), text })),
          response: {
            selected: null,
            struck: [],
            bookmarked: false,
            confidence: null,
            comment: "",
            updated_at: null,
          },
        })),
      };
      try {
        insert.run(doc.id, doc.run_id, JSON.stringify(doc));
      } catch (err) {
        if (String(err).includes("UNIQUE")) throw new DuplicateRunIdError(input.run_id);
        throw err;
      }
      return doc;
    },

    getById,

    getByRunId(runId: string): QuizDoc | undefined {
      return parse(selectByRunId.get(runId));
    },

    markStarted(id: string): QuizDoc | undefined {
      return update(id, (doc) => {
        if (doc.started_at) return false;
        doc.started_at = new Date().toISOString();
      });
    },

    patchResponse(id: string, number: number, patch: ResponsePatch): QuizDoc | undefined {
      return update(id, (doc) => {
        const question = doc.questions[number - 1];
        if (doc.status !== "open" || !question) return false;
        Object.assign(question.response, patch, { updated_at: new Date().toISOString() });
      });
    },

    submit(id: string): QuizDoc | undefined {
      return update(id, (doc) => {
        if (doc.status !== "open") return false;
        doc.status = "submitted";
        doc.submitted_at = new Date().toISOString();
      });
    },

    closeQuiz(id: string): QuizDoc | undefined {
      return update(id, (doc) => {
        if (doc.status !== "open") return false;
        doc.status = "closed";
        doc.closed_at = new Date().toISOString();
      });
    },

    close(): void {
      db.close();
    },
  };
}

export type Db = ReturnType<typeof openDb>;

// Temps écoulé depuis l'ouverture de la page, arrêté à la validation ou à la clôture.
export function timing(doc: QuizDoc, now = new Date()) {
  if (!doc.started_at) return { elapsed_seconds: 0, overtime_seconds: 0 };
  const endAt = doc.submitted_at ?? doc.closed_at;
  const end = endAt ? new Date(endAt) : now;
  const elapsed = Math.max(0, Math.round((end.getTime() - new Date(doc.started_at).getTime()) / 1000));
  const overtime = doc.time_limit_seconds === null ? 0 : Math.max(0, elapsed - doc.time_limit_seconds);
  return { elapsed_seconds: elapsed, overtime_seconds: overtime };
}
