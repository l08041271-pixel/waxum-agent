import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MATCH_THRESHOLD,
  bestMatch,
  chronological,
  extractContacts,
  extractMessages,
  levenshtein,
  messageLine,
  normalizeName,
  payloadRows,
  scoreMatch,
} from "../src/lib/contactMatch.ts";

test("normalizeName folds case, punctuation and accents", () => {
  assert.equal(normalizeName("  Budi  Santoso. "), "budi santoso");
  assert.equal(normalizeName("Rendí"), "rendi");
  assert.equal(normalizeName("Dewi's Cafe"), "dewi s cafe");
});

test("levenshtein counts insertions, deletions and substitutions", () => {
  assert.equal(levenshtein("budi", "budi"), 0);
  assert.equal(levenshtein("budi", "bud"), 1);
  assert.equal(levenshtein("randy", "rendi"), 2);
  assert.equal(levenshtein("", "abc"), 3);
});

test("scoreMatch prefers exact, then whole-word, then substring, then fuzzy", () => {
  assert.equal(scoreMatch("budi", "Budi"), 100);
  assert.equal(scoreMatch("budi", "Budi Santoso"), 95);
  assert.equal(scoreMatch("budi santoso", "Budi Santoso"), 100);
  assert.equal(scoreMatch("bu", "Budi"), 85);
  assert.ok(scoreMatch("randy", "Rendi") < 85 && scoreMatch("randy", "Rendi") >= MATCH_THRESHOLD);
  assert.equal(scoreMatch("", "Budi"), 0);
  assert.equal(scoreMatch("budi", ""), 0);
});

test("bestMatch picks the highest-scoring name and refuses weak matches", () => {
  const chats = [
    { name: "Budi Santoso", jid: "1@s.whatsapp.net" },
    { name: "Budiana", jid: "2@s.whatsapp.net" },
  ];
  const hit = bestMatch("budi", chats, (c) => c.name);
  assert.equal(hit?.jid, "1@s.whatsapp.net", "whole-word beats substring");

  assert.equal(bestMatch("randy", chats, (c) => c.name), undefined);
  assert.equal(bestMatch("", chats, (c) => c.name), undefined);
  assert.equal(bestMatch("budi", [], (c: { name: string }) => c.name), undefined);
});

test("bestMatch works on plain string names too", () => {
  assert.equal(bestMatch("grup keluarga", ["Grup Keluarga", "Grup Kerja"], (n) => n), "Grup Keluarga");
});

test("payloadRows understands every envelope waxum has used", () => {
  const rows = [{ body: "a" }];
  assert.deepEqual(payloadRows(rows), rows);
  assert.deepEqual(payloadRows({ messages: rows }), rows);
  assert.deepEqual(payloadRows({ results: rows }), rows);
  assert.deepEqual(payloadRows({ data: rows }), rows);
  assert.deepEqual(payloadRows({ data: { messages: rows } }), rows);
  assert.deepEqual(payloadRows({ data: { results: rows } }), rows);
  assert.deepEqual(payloadRows({ messages: [1, "x", null] }), [], "non-object rows are dropped");
  assert.deepEqual(payloadRows(null), []);
  assert.deepEqual(payloadRows("nope"), []);
});

test("extractContacts turns search hits into deduped chat candidates", () => {
  const payload = {
    messages: [
      { chat_jid: "6281@s.whatsapp.net", chat_name: "Budi", body: "otw" },
      { chat_jid: "6281@s.whatsapp.net", push_name: "Budi", body: "halo" },
      { chat_jid: "123@g.us", push_name: "Siti", chat_name: "Grup Keluarga", body: "makan" },
      { push_name: "Tanpa Jid", body: "hmm" },
    ],
  };
  assert.deepEqual(extractContacts(payload), [
    { name: "Budi", jid: "6281@s.whatsapp.net" },
    { name: "Grup Keluarga", jid: "123@g.us" },
  ]);
});

test("extractContacts falls back to the jid local part when unnamed", () => {
  assert.deepEqual(extractContacts([{ chat_jid: "628999@s.whatsapp.net", body: "x" }]), [
    { name: "628999", jid: "628999@s.whatsapp.net" },
  ]);
});

test("extractMessages normalises history rows and skips empty ones", () => {
  const rows = extractMessages({
    messages: [
      {
        message_id: "m1",
        chat_jid: "6281@s.whatsapp.net",
        push_name: "Budi",
        body: "otw",
        is_from_me: false,
      },
      { chat_jid: "123@g.us", sender_jid: "6282@s.whatsapp.net", push_name: "Siti", caption: "lihat ini" },
      { chat_jid: "6281@s.whatsapp.net", msg_type: "image" },
      { body: "no chat, dropped" },
    ],
  });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    messageId: "m1",
    chatJid: "6281@s.whatsapp.net",
    senderName: "Budi",
    senderJid: "",
    text: "otw",
    messageType: "",
    isGroup: false,
    fromMe: false,
  });
  assert.equal(rows[1].isGroup, true, "group inferred from the @g.us suffix");
  assert.equal(rows[1].text, "lihat ini", "caption is message text");
  assert.equal(rows[2].text, "", "type-only rows survive so '[image]' can still be spoken");
});

test("chronological flips waxum's newest-first history", () => {
  assert.deepEqual(chronological([3, 2, 1]), [1, 2, 3]);
});

test("messageLine prefixes group senders but not direct chats", () => {
  const base = {
    messageId: "",
    chatJid: "x",
    senderName: "Siti",
    senderJid: "",
    text: "makan",
    messageType: "",
    isGroup: true,
    fromMe: false,
  };
  assert.equal(messageLine(base), "Siti: makan");
  assert.equal(messageLine({ ...base, isGroup: false }), "makan");
  assert.equal(messageLine({ ...base, fromMe: true }), "makan");
  assert.equal(messageLine({ ...base, text: "", messageType: "image" }), "Siti: [image]");
});
