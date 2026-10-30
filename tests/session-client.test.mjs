import assert from "node:assert/strict";
import { test } from "node:test";
import { KagiSessionClient, parseSessionResponse } from "../dist/kagi/session-client.js";
import { KagiApiError, KagiNetworkError, KagiResponseError } from "../dist/kagi/client.js";

const events = (...frames) => frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");

test("parses Unicode deltas and detected language", () => {
  const result = parseSessionResponse(events(
    { detected_language: { iso: "fr", label: "French" } },
    { delta: "Schéma " }, { delta: "réseau." }, { text_done: true }
  ), false);
  assert.equal(result.translation, "Schéma réseau.");
  assert.equal(result.detected_language.iso, "fr");
});

test("proofread prefers the final analysis over streamed text", () => {
  const result = parseSessionResponse(events(
    { delta: "texte provisoire" }, { text_done: true },
    { analysis: { corrected_text: "Texte corrigé.", changes: [] } }, { done: true }
  ).replaceAll("\n", "\r\n"), true);
  assert.equal(result.corrected_text, "Texte corrigé.");
});

test("ignores event names and accepts final_text", () => {
  const result = parseSessionResponse(`event: message\n${events({ final_text: "Bonjour." }, { done: true })}`, true);
  assert.equal(result.corrected_text, "Bonjour.");
});

test("rejects malformed, failed, empty, and truncated streams", () => {
  for (const text of ["data: invalid\n\n", events({ error: "private detail" }),
    events({ delta: "partial" }), events({ done: true }), "<html>login</html>"]) {
    assert.throws(() => parseSessionResponse(text, false), KagiResponseError);
  }
});

test("bootstraps, sends session authentication, maps payloads, and batches", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, init });
    if (!init.method) return new Response("", { headers: { "Set-Cookie": "translate_session=fresh-token; Path=/" } });
    return new Response(events({ delta: "Hello" }, { text_done: true }), { headers: { "Content-Type": "text/event-stream" } });
  });
  const client = new KagiSessionClient({ authorization: "test-session", token: "old-token" });
  const result = await client.translateText({ texts: ["Bonjour", "Salut"], source_lang: "fr", target_lang: "en" });
  assert.deepEqual(result.translations, ["Hello", "Hello"]);
  assert.equal(calls.length, 3);
  const request = calls[1].init;
  assert.equal(request.headers["X-Kagi-Authorization"], "test-session");
  assert.equal(request.headers.Cookie, "kagi_session=test-session; translate_session=fresh-token");
  assert.equal(request.headers.Authorization, undefined);
  const body = JSON.parse(request.body);
  assert.equal(body.session_token, "fresh-token");
  assert.equal(body.from, "fr");
  assert.equal(body.to, "en");
  assert.equal(body.stream, true);
  await client.proofread({ text: "Bonjour", language: "fr" });
  assert.equal(JSON.parse(calls[3].init.body).source_lang, "fr");
});

test("401 is reported once, without retry or private response details", async (t) => {
  let posts = 0;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    if (!init.method) return new Response("", { headers: { "Set-Cookie": "translate_session=test; Path=/" } });
    posts++;
    return new Response("private details", { status: 401 });
  });
  const client = new KagiSessionClient({ authorization: "test-session" });
  await assert.rejects(client.proofread({ text: "Bonjour" }), (error) => {
    assert.ok(error instanceof KagiApiError);
    assert.equal(error.status, 401);
    assert.ok(!error.message.includes("private details"));
    return true;
  });
  assert.equal(posts, 1);
});

test("network errors do not expose credentials", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("secret-session"); });
  const client = new KagiSessionClient({ authorization: "secret-session" });
  await assert.rejects(client.proofread({ text: "Bonjour" }), (error) => {
    assert.ok(error instanceof KagiNetworkError);
    assert.ok(!error.message.includes("secret-session"));
    return true;
  });
});

test("unsupported URL translation fails explicitly", async () => {
  const client = new KagiSessionClient({ authorization: "test-session" });
  await assert.rejects(client.translateUrl({ url: "https://example.com", source_lang: "fr", target_lang: "en" }), KagiResponseError);
});
