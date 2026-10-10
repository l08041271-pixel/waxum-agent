import { test } from "node:test";
import assert from "node:assert/strict";

import { parseCommand } from "../src/lib/commandParser.ts";

test("reads the latest message, optionally scoped to a contact", () => {
  assert.deepEqual(parseCommand("baca pesan"), { kind: "read_latest", from: undefined });
  assert.deepEqual(parseCommand("bacain pesan"), { kind: "read_latest", from: undefined });
  assert.deepEqual(parseCommand("baca pesan dari budi"), { kind: "read_latest", from: "budi" });
  assert.deepEqual(parseCommand("bacain pesan dari budi"), { kind: "read_latest", from: "budi" });
  assert.deepEqual(parseCommand("tolong bacain pesan dari Budi"), {
    kind: "read_latest",
    from: "Budi",
  });
  assert.deepEqual(parseCommand("pesan terbaru dari budi"), { kind: "read_latest", from: "budi" });
  assert.deepEqual(parseCommand("apa pesan masuk dari budi"), { kind: "read_latest", from: "budi" });
});

test("recognises group reads and treats 'ini' as the current group", () => {
  assert.deepEqual(parseCommand("cek pesan di grup ini"), { kind: "read_group", group: undefined });
  assert.deepEqual(parseCommand("cek pesan di grup itu"), { kind: "read_group", group: undefined });
  assert.deepEqual(parseCommand("cek pesan di grup keluarga"), {
    kind: "read_group",
    group: "keluarga",
  });
  assert.deepEqual(parseCommand("baca pesan dari grup Keluarga"), {
    kind: "read_group",
    group: "Keluarga",
  });
  // A group read must not be swallowed by the contact read patterns and
  // turned into a contact literally named "grup keluarga".
  assert.notEqual(parseCommand("cek pesan di grup keluarga").kind, "read_latest");
});

test("parses every send shape", () => {
  assert.deepEqual(parseCommand("balas ke budi bilang otw"), {
    kind: "send_message",
    to: "budi",
    text: "otw",
  });
  assert.deepEqual(parseCommand("balas budi bilang otw"), {
    kind: "send_message",
    to: "budi",
    text: "otw",
  });
  assert.deepEqual(parseCommand("kirim pesan ke budi bilang otw"), {
    kind: "send_message",
    to: "budi",
    text: "otw",
  });
  assert.deepEqual(parseCommand("kirimkan ke budi: otw"), {
    kind: "send_message",
    to: "budi",
    text: "otw",
  });
  assert.deepEqual(parseCommand("Balas ke Budi Santoso dengan saya OTW"), {
    kind: "send_message",
    to: "Budi Santoso",
    text: "saya OTW",
  });
});

test("a name that starts with a separator word is not torn in half", () => {
  // The loosened separator must still require whitespace before a word
  // separator, or "Isian" matches the `isi` alternative and the name comes
  // back as "Bu" with "an bilang otw" as the message.
  assert.deepEqual(parseCommand("balas ke Bu Isian bilang otw"), {
    kind: "send_message",
    to: "Bu Isian",
    text: "otw",
  });
  assert.deepEqual(parseCommand("kirim pesan ke Isian bilang otw"), {
    kind: "send_message",
    to: "Isian",
    text: "otw",
  });
  assert.deepEqual(parseCommand("balas ke budi dengan senang hati"), {
    kind: "send_message",
    to: "budi",
    text: "senang hati",
  });
});

test("a colon may butt straight up against the contact name", () => {
  assert.deepEqual(parseCommand("balas ke budi: otw"), { kind: "send_message", to: "budi", text: "otw" });
  assert.deepEqual(parseCommand("balas ke budi:otw"), { kind: "send_message", to: "budi", text: "otw" });
  assert.deepEqual(parseCommand("kirim pesan ke budi: otw"), {
    kind: "send_message",
    to: "budi",
    text: "otw",
  });
});

test("reads accept 'baca' and 'bacain', not the typo 'bacai'", () => {
  assert.equal(parseCommand("bacai pesan dari budi").kind, "unknown");
  assert.deepEqual(parseCommand("bacain pesan dari budi"), { kind: "read_latest", from: "budi" });
});

test("lists sessions", () => {
  assert.deepEqual(parseCommand("list sesi"), { kind: "list_sessions" });
  assert.deepEqual(parseCommand("daftar session"), { kind: "list_sessions" });
});

test("falls through to unknown for free-form speech", () => {
  assert.deepEqual(parseCommand("halo ada pesan apa aja"), {
    kind: "unknown",
    raw: "halo ada pesan apa aja",
  });
  assert.deepEqual(parseCommand("   "), { kind: "unknown", raw: "   " });
  assert.equal(parseCommand("gimana cuaca hari ini").kind, "unknown");
});
