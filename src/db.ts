// Seule couche d'accès aux données, partagée par l'API MCP et l'interface web.
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export type SessionStatus = "open" | "closed";

export interface Session {
  id: string;
  question: string;
  status: SessionStatus;
  created_at: string;
}

export interface Answer {
  id: number;
  text: string;
  created_at: string;
}

export function openDb(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      question   TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS answers (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      text       TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  return {
    createSession(question: string): Session {
      const session: Session = {
        id: randomUUID(),
        question,
        status: "open",
        created_at: new Date().toISOString(),
      };
      db.prepare(
        "INSERT INTO sessions (id, question, status, created_at) VALUES (?, ?, ?, ?)",
      ).run(session.id, session.question, session.status, session.created_at);
      return session;
    },

    getSession(id: string): Session | undefined {
      return db
        .prepare("SELECT id, question, status, created_at FROM sessions WHERE id = ?")
        .get(id) as Session | undefined;
    },

    listAnswers(sessionId: string): Answer[] {
      return db
        .prepare("SELECT id, text, created_at FROM answers WHERE session_id = ? ORDER BY id")
        .all(sessionId) as unknown as Answer[];
    },

    addAnswer(sessionId: string, text: string): void {
      db.prepare("INSERT INTO answers (session_id, text, created_at) VALUES (?, ?, ?)").run(
        sessionId,
        text,
        new Date().toISOString(),
      );
    },

    closeSession(id: string): void {
      db.prepare("UPDATE sessions SET status = 'closed' WHERE id = ?").run(id);
    },

    close(): void {
      db.close();
    },
  };
}

export type Db = ReturnType<typeof openDb>;

export const QUESTION_MAX = 2000;
export const ANSWER_MAX = 5000;
