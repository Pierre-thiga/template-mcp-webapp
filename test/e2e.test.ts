import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { start } from "../src/server.ts";

const PUBLIC_URL = "http://quiz-runner.test";
let base: string;
let stop: () => void;
let client: Client;
let tmp: string;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "quiz-runner-"));
  const app = await start({ port: 0, host: "127.0.0.1", publicUrl: PUBLIC_URL, dbPath: join(tmp, "test.db") });
  stop = app.close;
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
});

after(async () => {
  await client.close();
  stop();
  rmSync(tmp, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown>) {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[];
    isError?: boolean;
  };
  const text = res.content[0]!.text;
  return { isError: res.isError ?? false, text, data: res.isError ? undefined : JSON.parse(text) };
}

function put(quizId: string, number: number | string, body: unknown) {
  return fetch(`${base}/q/${quizId}/responses/${number}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const submit = (quizId: string) => fetch(`${base}/q/${quizId}/submit`, { method: "POST" });

const QUESTIONS = [
  { text: "Which is <b>bold</b>?", choices: ["<b>", "<i>", "<u>"] },
  { text: "2 + 2 = ?", choices: ["3", "4"] },
  { text: "Pick one", choices: ["A", "B", "C", "D"] },
];

test("flux complet : création, ouverture, réponses, validation", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["close_quiz", "create_quiz", "get_quiz_results"]);

  const created = await call("create_quiz", {
    run_id: "run-1",
    name: "Demo quiz",
    time_limit_minutes: 10,
    questions: QUESTIONS,
  });
  assert.equal(created.isError, false, created.text);
  const id: string = created.data.quiz_id;
  assert.equal(created.data.url, `${PUBLIC_URL}/q/${id}`);
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(created.data.question_count, 3);

  // Pas encore ouvert : timer non démarré.
  let results = (await call("get_quiz_results", { run_id: "run-1" })).data;
  assert.equal(results.started_at, null);
  assert.equal(results.answered_count, 0);
  assert.equal(results.time_limit_seconds, 600);

  // run_id unique.
  assert.equal((await call("create_quiz", { run_id: "run-1", name: "x", questions: QUESTIONS })).isError, true);

  const pageRes = await fetch(`${base}/q/${id}`);
  assert.equal(pageRes.status, 200);
  const page = await pageRes.text();
  assert.ok(page.includes("<title>Demo quiz</title>"));
  assert.ok(!page.includes("<b>bold</b>"), "le JSON embarqué n'injecte pas de HTML");
  assert.ok(page.includes("\\u003cb>bold\\u003c/b>"));
  assert.ok(page.includes('src="/quiz.js"'));
  assert.equal((await fetch(`${base}/quiz.js`)).status, 200);
  assert.equal((await fetch(`${base}/quiz.css`)).status, 200);

  results = (await call("get_quiz_results", { run_id: "run-1" })).data;
  const startedAt = results.started_at;
  assert.ok(startedAt, "timer démarré à l'ouverture");
  await fetch(`${base}/q/${id}`);
  assert.equal((await call("get_quiz_results", { run_id: "run-1" })).data.started_at, startedAt, "pas redémarré");

  // Patches partiels.
  assert.equal((await put(id, 1, { selected: "A" })).status, 200);
  assert.equal((await put(id, 1, { struck: ["B", "C"], confidence: "high" })).status, 200);
  assert.equal((await put(id, 2, { bookmarked: true, comment: "Not sure <ok>" })).status, 200);
  const last = await put(id, 3, { selected: "D", confidence: "low" });
  assert.equal(last.status, 200);
  assert.equal((await last.json()).response.selected, "D");
  assert.equal((await put(id, 3, { selected: null })).status, 200);

  // Patches invalides.
  assert.equal((await put(id, 2, { selected: "C" })).status, 400, "lettre hors plage");
  assert.equal((await put(id, 1, { struck: ["A", "A"] })).status, 400, "doublon");
  assert.equal((await put(id, 1, { confidence: "maybe" })).status, 400);
  assert.equal((await put(id, 1, { foo: 1 })).status, 400, "champ inconnu");
  assert.equal((await put(id, 4, { selected: "A" })).status, 400, "question inexistante");
  assert.equal((await put(id, "x", { selected: "A" })).status, 400);
  assert.equal((await put("nope", 1, { selected: "A" })).status, 404);

  results = (await call("get_quiz_results", { run_id: "run-1" })).data;
  assert.equal(results.status, "open");
  assert.equal(results.answered_count, 1);
  assert.deepEqual(results.responses, [
    { number: 1, selected: "A", struck: ["B", "C"], bookmarked: false, confidence: "high", comment: "" },
    { number: 2, selected: null, struck: [], bookmarked: true, confidence: null, comment: "Not sure <ok>" },
    { number: 3, selected: null, struck: [], bookmarked: false, confidence: "low", comment: "" },
  ]);

  const submitted = await submit(id);
  assert.equal(submitted.status, 200);
  assert.equal((await submitted.json()).status, "submitted");
  assert.equal((await submit(id)).status, 409);
  assert.equal((await put(id, 2, { selected: "B" })).status, 409, "copie verrouillée");

  results = (await call("get_quiz_results", { run_id: "run-1" })).data;
  assert.equal(results.status, "submitted");
  assert.ok(results.submitted_at);
  assert.equal(results.overtime_seconds, 0);

  // close_quiz ne change pas une copie validée.
  assert.equal((await call("close_quiz", { run_id: "run-1" })).data.status, "submitted");
});

test("close_quiz verrouille un quiz ouvert", async () => {
  const created = await call("create_quiz", { run_id: "run-2", name: "No limit", questions: QUESTIONS.slice(0, 1) });
  const id: string = created.data.quiz_id;
  assert.equal(created.data.time_limit_minutes, null);
  assert.equal((await call("close_quiz", { run_id: "run-2" })).data.status, "closed");
  assert.equal((await call("close_quiz", { run_id: "run-2" })).data.status, "closed");
  assert.equal((await put(id, 1, { selected: "A" })).status, 409);
  assert.equal((await submit(id)).status, 409);
  const results = (await call("get_quiz_results", { run_id: "run-2" })).data;
  assert.equal(results.status, "closed");
  assert.equal(results.time_limit_seconds, null);
});

test("validation de create_quiz", async () => {
  const oneChoice = await call("create_quiz", { run_id: "bad-1", name: "x", questions: [{ text: "q", choices: ["only"] }] });
  assert.equal(oneChoice.isError, true);
  const noQuestions = await call("create_quiz", { run_id: "bad-2", name: "x", questions: [] });
  assert.equal(noQuestions.isError, true);
  const badTime = await call("create_quiz", { run_id: "bad-3", name: "x", time_limit_minutes: 0, questions: QUESTIONS });
  assert.equal(badTime.isError, true);
});

test("run ou quiz inconnu", async () => {
  assert.equal((await call("get_quiz_results", { run_id: "nope" })).isError, true);
  assert.equal((await call("close_quiz", { run_id: "nope" })).isError, true);
  assert.equal((await fetch(`${base}/q/nope`)).status, 404);
  assert.equal((await submit("nope")).status, 404);
});

async function withStdio(env: Record<string, string>, fn: (c: Client) => Promise<void>) {
  const stdio = new Client({ name: "e2e-stdio", version: "0.0.0" });
  await stdio.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [new URL("../src/stdio.ts", import.meta.url).pathname],
      env: { ...process.env, ...env } as Record<string, string>,
      stderr: "ignore",
    }),
  );
  try {
    await fn(stdio);
  } finally {
    await stdio.close();
  }
}

async function stdioCreate(c: Client, runId: string) {
  const res = (await c.callTool({
    name: "create_quiz",
    arguments: { run_id: runId, name: "Via stdio", questions: QUESTIONS },
  })) as { content: { text: string }[] };
  return JSON.parse(res.content[0]!.text) as { url: string };
}

test("stdio : le process sert lui-même les pages", async () => {
  const free = await start({ port: 0, host: "127.0.0.1", publicUrl: "", dbPath: ":memory:" });
  const port = (free.server.address() as AddressInfo).port;
  free.close();
  const own = `http://127.0.0.1:${port}`;
  await withStdio({ PORT: String(port), PUBLIC_URL: own, DB_PATH: join(tmp, "stdio.db") }, async (c) => {
    const { tools } = await c.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["close_quiz", "create_quiz", "get_quiz_results"]);
    const { url } = await stdioCreate(c, "stdio-own");
    assert.ok(url.startsWith(`${own}/q/`));
    assert.equal((await fetch(url)).status, 200);
    assert.equal((await fetch(`${own}/mcp`, { method: "POST" })).status, 404, "pas de MCP HTTP en mode stdio");
  });
  await assert.rejects(fetch(`${own}/healthz`), "port libéré à la fermeture");
});

test("stdio : port déjà servi par quiz-runner, base partagée", async () => {
  const port = new URL(base).port;
  await withStdio({ PORT: port, PUBLIC_URL: base, DB_PATH: join(tmp, "test.db") }, async (c) => {
    const { url } = await stdioCreate(c, "stdio-shared");
    // La page est servie par le serveur HTTP du test, qui lit la même base.
    assert.equal((await fetch(url)).status, 200);
  });
  assert.equal((await call("get_quiz_results", { run_id: "stdio-shared" })).data.status, "open");
});
