import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { start } from "../src/server.ts";

const PUBLIC_URL = "http://ask-human.test";
let base: string;
let stop: () => void;
let client: Client;
let tmp: string;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "ask-human-"));
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

function answer(sessionId: string, text: string) {
  return fetch(`${base}/s/${sessionId}/answers`, {
    method: "POST",
    body: new URLSearchParams({ text }),
    redirect: "manual",
  });
}

test("flux complet : question, réponses, lecture, clôture", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["ask_question", "close_session", "get_answers"]);

  const asked = await call("ask_question", { question: "Postgres <ou> SQLite ?" });
  const id: string = asked.data.session_id;
  assert.match(asked.data.url, new RegExp(`^${PUBLIC_URL}/s/[0-9a-f-]{36}$`));
  assert.equal(asked.data.url, `${PUBLIC_URL}/s/${id}`);

  const page = await (await fetch(`${base}/s/${id}`)).text();
  assert.ok(page.includes("Postgres &lt;ou&gt; SQLite ?"), "question échappée");
  assert.ok(page.includes("<form"), "formulaire présent");

  assert.deepEqual((await call("get_answers", { session_id: id })).data.answers, []);

  for (const text of ["SQLite", "Postgres"]) {
    const res = await answer(id, text);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), `/s/${id}`);
  }
  assert.equal((await answer(id, "   ")).status, 400);

  const got = await call("get_answers", { session_id: id });
  assert.equal(got.data.question, "Postgres <ou> SQLite ?");
  assert.equal(got.data.status, "open");
  assert.deepEqual(got.data.answers.map((a: { text: string }) => a.text), ["SQLite", "Postgres"]);

  assert.equal((await call("close_session", { session_id: id })).data.status, "closed");
  assert.equal((await answer(id, "trop tard")).status, 409);
  const closedPage = await (await fetch(`${base}/s/${id}`)).text();
  assert.ok(!closedPage.includes("<form"), "plus de formulaire");
  assert.equal((await call("get_answers", { session_id: id })).data.status, "closed");
});

test("session inconnue", async () => {
  const res = await call("get_answers", { session_id: "nope" });
  assert.equal(res.isError, true);
  assert.equal((await fetch(`${base}/s/nope`)).status, 404);
});
