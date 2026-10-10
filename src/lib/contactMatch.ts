/**
 * Matching a *spoken* name ("budi", "randy") against chat names, and
 * turning waxum's message/search payloads into something the command
 * pipeline can use.
 *
 * Kept pure and dependency-free (no Tauri, no DOM) for two reasons: it is
 * the one piece of contact resolution worth unit-testing without spinning
 * up the app, and it is shared by the local regex path and the live-search
 * fallback so both rank names the same way. The scoring mirrors
 * `score_contact` on the Rust side (`src-tauri/src/ai.rs`), which the AI's
 * `search_contact` tool uses, so a name that resolves one way resolves the
 * same way on the other.
 *
 * waxum payloads are read defensively: this app talks to a server it does
 * not ship, and the same message arrives as a live SSE event, a
 * `/messages` history row, or a `/messages/search` hit. Rather than
 * trusting one exact key set, every field is looked up through a list of
 * aliases and anything unrecognised is skipped instead of throwing.
 */

export interface ContactCandidate {
  name: string;
  jid: string;
}

/** One message, normalised from whichever payload shape it arrived in. */
export interface RawMessage {
  messageId: string;
  chatJid: string;
  /** Display name of whoever sent it (push name / contact name). */
  senderName: string;
  senderJid: string;
  text: string;
  messageType: string;
  isGroup: boolean;
  fromMe: boolean;
}

/** Lowest score `bestMatch` still accepts. Exact = 100, substring = 85,
 * anything below this is treated as "no such contact" rather than guessing
 * at the least-bad option — sending a message to the wrong person is worse
 * than asking the user to repeat themselves. */
export const MATCH_THRESHOLD = 60;

/** Lowercase, strip punctuation/diacritics, collapse whitespace. "Rendi."
 * and "rendi" have to normalise to the same string to match at all. */
export function normalizeName(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Plain Levenshtein edit distance over chars — enough for "Randy" vs
 * "Rendi"-shaped mis-hearings without pulling in a package for it. */
export function levenshtein(a: string, b: string): number {
  const s = Array.from(a);
  const t = Array.from(b);
  const prev = new Array<number>(t.length + 1);
  const cur = new Array<number>(t.length + 1);
  for (let j = 0; j <= t.length; j++) prev[j] = j;
  for (let i = 1; i <= s.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= t.length; j++) prev[j] = cur[j];
  }
  return prev[t.length];
}

/** 0-100 confidence that `name` is what `query` meant. */
export function scoreMatch(query: string, name: string): number {
  const q = normalizeName(query);
  const n = normalizeName(name);
  if (!q || !n) return 0;
  if (q === n) return 100;
  // Whole-word hits are what "budi" -> "budi santoso" usually is; keep them
  // above the fuzzy band so a short spoken name prefers a real substring
  // match over a coincidental edit-distance neighbour.
  if (n.split(" ").includes(q)) return 95;
  if (n.includes(q) || q.includes(n)) return 85;
  const longest = Math.max(q.length, n.length, 1);
  return Math.round(100 - (levenshtein(q, n) * 100) / longest);
}

/**
 * Best-scoring item for a spoken name, or `undefined` if nothing clears
 * `threshold`. Callers pass the accessor so this stays generic over
 * `ChatEntry`s, `ContactCandidate`s, or plain string names.
 */
export function bestMatch<T>(
  query: string,
  items: readonly T[],
  nameOf: (item: T) => string,
  threshold = MATCH_THRESHOLD,
): T | undefined {
  let best: T | undefined;
  let bestScore = 0;
  for (const item of items) {
    const score = scoreMatch(query, nameOf(item));
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return bestScore >= threshold ? best : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** First non-empty string among `keys` — waxum renames fields between
 * endpoints, so every read goes through the alias list. */
function pick(row: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = str(row[key]).trim();
    if (value) return value;
  }
  return "";
}

function flag(row: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => row[key] === true);
}

/** The row array inside a waxum payload: `{messages: [...]}`,
 * `{results: [...]}`, `{data: [...]}`, `{data: {messages: [...]}}`, or a
 * bare array. */
export function payloadRows(payload: unknown): Record<string, unknown>[] {
  const root = asRecord(payload);
  const nested = asRecord(root?.["data"]);
  const candidates: unknown[] = [
    payload,
    root?.["messages"],
    root?.["results"],
    root?.["data"],
    nested?.["messages"],
    nested?.["results"],
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate
        .map(asRecord)
        .filter((row): row is Record<string, unknown> => row !== undefined);
    }
  }
  return [];
}

/** Local part of a JID, used as a last-resort display name. */
function jidName(jid: string): string {
  return jid.split("@")[0] ?? "";
}


/**
 * The people behind a `/messages/search` response. Every hit carries the
 * chat it belongs to; a chat name is preferred over the sender's, so a
 * search that returns group messages resolves to the group rather than to
 * whichever member happened to send it.
 */
export function extractContacts(payload: unknown): ContactCandidate[] {
  const out: ContactCandidate[] = [];
  const seen = new Set<string>();
  for (const row of payloadRows(payload)) {
    const jid = pick(row, ["chat_jid", "chat", "jid", "sender_jid", "from"]);
    if (!jid || !jid.includes("@") || seen.has(jid)) continue;
    const isGroup =
      pick(row, ["chat_type", "type"]).toLowerCase() === "group" || jid.endsWith("@g.us");
    const name =
      (isGroup
        ? pick(row, ["chat_name", "subject", "group_name"])
        : pick(row, ["chat_name", "contact_name", "push_name", "name"])) ||
      pick(row, ["push_name", "sender_name", "name"]) ||
      jidName(jid);
    seen.add(jid);
    out.push({ name, jid });
  }
  return out;
}

/**
 * Normalise message rows from `/messages`, `/messages/chat/{jid}` or an SSE
 * event. Rows with no chat and no content are dropped; the rest keep their
 * original order (waxum returns history newest-first, so callers that want
 * chronological order use `chronological()`).
 */
export function extractMessages(payload: unknown): RawMessage[] {
  const out: RawMessage[] = [];
  for (const row of payloadRows(payload)) {
    const jid = pick(row, ["chat_jid", "chat", "jid", "sender_jid", "from"]);
    if (!jid) continue;
    const text = pick(row, ["body", "text", "caption", "content"]);
    const messageType = pick(row, ["msg_type", "message_type", "type"]);
    if (!text && !messageType) continue;
    out.push({
      messageId: pick(row, ["message_id", "id", "key_id"]),
      chatJid: jid,
      senderName: pick(row, ["push_name", "sender_name", "name", "notify_name"]),
      senderJid: pick(row, ["sender_jid", "from", "participant"]),
      text,
      messageType,
      isGroup:
        flag(row, ["is_group", "from_group"]) ||
        pick(row, ["chat_type"]).toLowerCase() === "group" ||
        jid.endsWith("@g.us"),
      fromMe: flag(row, ["is_from_me", "from_me"]),
    });
  }
  return out;
}

/** waxum history is newest-first; everything the UI speaks/prints is
 * oldest-first, so the flip lives in one place. */
export function chronological<T>(messages: readonly T[]): T[] {
  return [...messages].reverse();
}

/** What to say/print for one message: groups are prefixed with who sent it,
 * direct chats aren't (the chat *is* the sender). */
export function messageLine(message: RawMessage): string {
  const text = message.text || `[${message.messageType || "pesan"}]`;
  if (message.isGroup && message.senderName && !message.fromMe) {
    return `${message.senderName}: ${text}`;
  }
  return text;
}

