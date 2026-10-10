/**
 * Turns a transcript into an intent. Regex-based on purpose — voice
 * commands here are a handful of fixed shapes ("baca pesan dari X",
 * "balas ke X bilang Y", "cek pesan di grup X"), not open-ended natural
 * language, so a small language model would be overkill for what a few
 * patterns already cover. Add a pattern here rather than reaching for an
 * LLM unless free-form commands become a real requirement.
 */

export type Intent =
  | { kind: "read_latest"; from?: string }
  | { kind: "read_group"; group?: string }
  | { kind: "send_message"; to: string; text: string }
  | { kind: "list_sessions" }
  | { kind: "unknown"; raw: string };

const READ_PATTERNS = [
  // `baca(?:in)?` -- the old `bacain?` accepted "bacai", which is not a
  // word, while rejecting nothing real; GROUP_PATTERNS already had it right.
  /^(?:tolong\s+)?baca(?:in)?\s+(?:pesan\s*)?(?:dari\s+(.+))?$/i,
  /^(?:tolong\s+)?baca(?:in)?\s+pesan\s*(?:dari\s+(.+))?$/i,
  /^(?:apa\s+)?pesan\s+(?:terbaru|masuk)\s*(?:dari\s+(.+))?$/i,
];

/** "cek pesan di grup ini" / "...grup keluarga" -- an unnamed ("ini") group
 * means the most recently active one, which the caller tracks. */
const GROUP_PATTERNS = [/^(?:cek|lihat|liat|baca(?:in)?)\s+pesan\s+(?:di|dari)\s+grup\s*(.*)$/i];

/** Words that mean "the group I'm looking at", not a group *named* that. */
const CURRENT_GROUP = /^(ini|itu|tersebut|yang ini|yang itu)$/i;

// The separator between the name and the message body has to be careful
// about where the name ends. A word separator needs whitespace in front of
// it (`budi bilang otw`) *and* a non-word character after it, or a name that
// merely starts with one of these words gets torn in half: "balas ke Bu
// Isian bilang otw" would split at "Isi" and send "an bilang otw" to "Bu".
// A colon is unambiguous, so it is allowed to butt straight up against the
// name ("kirimkan ke budi: otw") -- which is how dictation usually arrives.
const SEND_PATTERNS = [
  /^(?:balas|reply)\s+(?:ke\s+)?(.+?)(?:\s+(?:bilang|dengan|isi(?:nya)?)(?![a-z0-9])\s*|:\s+)(.+)$/i,
  /^kirim(?:kan)?\s+pesan\s+ke\s+(.+?)(?:\s+(?:bilang|isi(?:nya)?)(?![a-z0-9])\s*|:\s+)(.+)$/i,
  /^kirim(?:kan)?\s+ke\s+(.+?)(?:\s+(?:bilang)(?![a-z0-9])\s*|:\s+)(.+)$/i,
];

const LIST_PATTERNS = [/^(?:list|daftar)\s+(?:sesi|session)$/i];

export function parseCommand(raw: string): Intent {
  const text = raw.trim();
  if (!text) return { kind: "unknown", raw };

  // Groups are matched before the generic read patterns, which would
  // otherwise capture "grup keluarga" as a contact named that.
  for (const pattern of GROUP_PATTERNS) {
    const m = text.match(pattern);
    if (m) {
      const rest = (m[1] ?? "").trim();
      return { kind: "read_group", group: !rest || CURRENT_GROUP.test(rest) ? undefined : rest };
    }
  }

  for (const pattern of READ_PATTERNS) {
    const m = text.match(pattern);
    if (m) return { kind: "read_latest", from: m[1]?.trim() };
  }

  for (const pattern of SEND_PATTERNS) {
    const m = text.match(pattern);
    if (m) return { kind: "send_message", to: m[1].trim(), text: m[2].trim() };
  }

  for (const pattern of LIST_PATTERNS) {
    if (pattern.test(text)) return { kind: "list_sessions" };
  }

  return { kind: "unknown", raw: text };
}
