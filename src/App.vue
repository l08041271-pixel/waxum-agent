<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import SetupView from "./components/SetupView.vue";
import VoiceBar from "./components/VoiceBar.vue";
import PairingModal from "./components/PairingModal.vue";
import LiveClock from "./components/LiveClock.vue";
import RobotFace from "./components/RobotFace.vue";
import { launchBundled } from "./lib/bundled";
import { loadSettings, saveSettings } from "./lib/settings";
import type { IncomingMessage, Settings } from "./lib/types";
import {
  onIncomingMessage,
  onStreamStatus,
  startEventStream,
  stopEventStream,
  waxumChatMessages,
  waxumGroupInfo,
  waxumSearch,
  waxumSendText,
  waxumSessionMessages,
  waxumStatus,
} from "./lib/waxum";
import { speak } from "./lib/voice";
import { parseCommand } from "./lib/commandParser";
import {
  bestMatch,
  chronological,
  extractContacts,
  extractMessages,
  messageLine,
  type ContactCandidate,
} from "./lib/contactMatch";
import {
  aiConfigured,
  aiConverse,
  aiResetConversation,
  onAiStream,
  onAiTool,
  type AiContact,
} from "./lib/ai";
import { motion, AnimatePresence } from "motion-v";

const ready = ref(false);
const settings = ref<Settings | null>(null);
const showSettings = ref(false);
const busy = ref(false);
const statusLine = ref("");
const sessionReady = ref(false);
const showPairing = ref(false);
const typedCommand = ref("");

/** Drives RobotFace: offline (no session) -> idle/listening (voice bar
 * mic state) -> thinking/speaking (transient, while a command/AI call or
 * TTS playback is in flight), then back to idle/listening. */
const listening = ref(false);
const transientState = ref<"thinking" | "speaking" | null>(null);
/** The scrolling transcript pane, so new lines can be followed automatically. */
const logEl = ref<HTMLElement | null>(null);
/** Filled chunk-by-chunk from ai-stream events while the AI reply is being
 * generated, so the UI shows progress instead of a dead "thinking" state
 * for however long the full completion takes. */
const streamingReply = ref("");
const assistantState = computed<"offline" | "idle" | "listening" | "thinking" | "speaking">(() => {
  if (!sessionReady.value) return "offline";
  if (transientState.value) return transientState.value;
  return listening.value ? "listening" : "idle";
});

/** Utterances are queued, not fired off in parallel. Two messages arriving
 * together (or an incoming message landing while a command's reply is being
 * spoken) used to start two <audio> elements at once, so the assistant read
 * both at the same time and neither was intelligible -- the whole point of
 * reading messages aloud. `pending` keeps the robot face on "speaking" for
 * as long as *anything* is still being spoken. */
let speechQueue: Promise<void> = Promise.resolve();
let pendingSpeech = 0;

function speakState(s: Settings, text: string): Promise<void> {
  pendingSpeech += 1;
  transientState.value = "speaking";
  speechQueue = speechQueue
    .catch(() => {})
    .then(() => speak(s, text))
    .catch((e) => pushLog(`tts failed: ${e}`, "system"))
    .then(() => {
      pendingSpeech -= 1;
      if (pendingSpeech === 0 && transientState.value === "speaking") {
        transientState.value = null;
      }
    });
  return speechQueue;
}

function submitTyped() {
  const text = typedCommand.value.trim();
  const s = settings.value;
  if (!text || !s) return;
  typedCommand.value = "";
  // Typed commands skip the wake-word gate. The gate exists so an
  // always-open mic never treats overheard speech as a command; there is
  // nothing to gate when the user typed it on purpose. Going through
  // onTranscript() here meant the input box silently did nothing unless
  // you typed "hey jarvis" first and then the command as a second line.
  clearAwakeTimer();
  awaitingCommand.value = false;
  void processCommand(s, text);
}
const log = reactive<{ id: string; text: string; kind: "in" | "out" | "system"; time: string }[]>([]);

/** chat display name -> jid, learned from every incoming SSE message so
 * voice commands can say "balas ke budi" instead of a raw JID. */
interface ChatEntry {
  jid: string;
  messages: string[]; // oldest first, capped — enough for "cek pesan di grup ini"
}
const HISTORY_PER_CHAT = 10;
const knownChats = reactive(new Map<string, ChatEntry>());

/** Group whose messages arrived most recently -- what "grup ini" means in
 * "cek pesan di grup ini". */
let lastGroupJid = "";

function appendChatMessage(name: string, jid: string, text: string) {
  const key = name.toLowerCase();
  const entry = knownChats.get(key) ?? { jid, messages: [] };
  entry.jid = jid;
  entry.messages.push(text);
  if (entry.messages.length > HISTORY_PER_CHAT) entry.messages.shift();
  knownChats.set(key, entry);
  if (jid.endsWith("@g.us")) lastGroupJid = jid;
}

/** group jid -> subject, so a group's context/log entries are keyed by
 * "the group" rather than whichever member happened to send last. */
const groupNames = new Map<string, string>();

async function resolveGroupName(jid: string): Promise<string> {
  const cached = groupNames.get(jid);
  if (cached) return cached;
  const fallback = `Grup ${jid.split("@")[0].slice(-6)}`;
  try {
    const info = await waxumGroupInfo(settings.value!, jid);
    const name = info.subject?.trim() || fallback;
    groupNames.set(jid, name);
    return name;
  } catch {
    groupNames.set(jid, fallback);
    return fallback;
  }
}

let unlistenMessage: (() => void) | null = null;
let unlistenStatus: (() => void) | null = null;
let unlistenAiStream: (() => void) | null = null;
let unlistenAiTool: (() => void) | null = null;

/** message_id set shared between history load and live SSE, so a message
 * that arrives while history is still loading (or gets fetched again on
 * a reconnect) never shows up twice in the log. */
const seenMessageIds = new Set<string>();
let historyLoaded = false;

function pushLog(text: string, kind: "in" | "out" | "system") {
  const time = new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  log.push({ id: crypto.randomUUID(), text, kind, time });
  if (log.length > 200) log.shift();
}

/** Primes knownChats from waxum's stored history — silently, as context
 * for voice/AI commands ("cek pesan di grup ini") and contact resolution.
 * Deliberately NOT pushed into the visible log: the screen only ever
 * shows live messages and things explicitly asked for, not a full history
 * dump on every launch. */
async function loadHistory() {
  if (historyLoaded) return;
  const s = settings.value!;
  try {
    const res = await waxumSessionMessages(s, 50);
    for (const m of chronological(extractMessages(res))) {
      if (m.messageId && seenMessageIds.has(m.messageId)) continue;
      if (m.messageId) seenMessageIds.add(m.messageId);
      // messageLine() already prefixes the sender for groups, so both
      // branches store the same shape handleIncoming() does.
      if (m.isGroup) {
        const groupName = await resolveGroupName(m.chatJid);
        appendChatMessage(groupName, m.chatJid, messageLine(m));
      } else {
        const name = m.senderName || m.chatJid.split("@")[0];
        appendChatMessage(name, m.chatJid, messageLine(m));
      }
    }
    historyLoaded = true;
  } catch (e) {
    pushLog(`gagal memuat riwayat pesan: ${e}`, "system");
  }
}

async function boot() {
  settings.value = await loadSettings();
  const s = settings.value;
  const configured = s.sessionId && (s.mode === "bundled" || (s.token && s.baseUrl));
  showSettings.value = !configured;
  ready.value = true;
  if (configured) await connect();
}

/** Everything learned from the previous connection is dropped before a new
 * one starts. After switching servers/sessions (or reconnecting) a stale
 * knownChats/seenMessageIds silently answered commands with the old
 * session's contacts, and `historyLoaded` stayed true, so the new
 * session's history was never fetched at all. */
function resetSessionCaches() {
  knownChats.clear();
  groupNames.clear();
  seenMessageIds.clear();
  lastGroupJid = "";
  historyLoaded = false;
  streamingReply.value = "";
  aiResetConversation().catch(() => {});
}

async function connect() {
  const s = settings.value!;
  resetSessionCaches();
  busy.value = true;
  statusLine.value = "connecting…";
  try {
    if (s.mode === "bundled") {
      statusLine.value = "starting waxum (first run downloads it)…";
      await launchBundled(s);
      await saveSettings(s);
    }
    await startEventStream(s);
    await refreshSessionStatus();
  } catch (e) {
    statusLine.value = `connection failed: ${e}`;
    sessionReady.value = false;
  } finally {
    busy.value = false;
  }
}

/** Checks the actual waxum session status — a live SSE stream and a
 * "connect succeeded" toast mean nothing if the session was never paired,
 * so this is the only thing allowed to claim "connected". */
async function refreshSessionStatus() {
  const s = settings.value!;
  try {
    const status = await waxumStatus(s);
    sessionReady.value = status.status === "logged_in";
    statusLine.value = sessionReady.value
      ? "connected — listening for messages"
      : `session not paired yet (status: ${status.status ?? "unknown"})`;
    if (sessionReady.value) await loadHistory();
  } catch (e) {
    sessionReady.value = false;
    statusLine.value = `couldn't check session status: ${e}`;
  }
}

function onListeningChange(v: boolean) {
  listening.value = v;
}

function onPairedFromMain() {
  showPairing.value = false;
  refreshSessionStatus();
}

async function onSaveSettings(s: Settings) {
  await saveSettings(s);
  settings.value = s;
  showSettings.value = false;
  await stopEventStream().catch(() => {});
  await connect();
}

function chatDisplayName(msg: IncomingMessage): string {
  return msg.data.push_name || msg.data.from_phone || msg.data.chat;
}

async function handleIncoming(msg: IncomingMessage) {
  if (msg.data.is_from_me) return;
  if (seenMessageIds.has(msg.data.message_id)) return;
  seenMessageIds.add(msg.data.message_id);

  const sender = chatDisplayName(msg);
  const text = msg.data.text || msg.data.caption || `[${msg.data.message_type}]`;

  let chatName = sender;
  let logLine = `${sender}: ${text}`;
  let spoken = `Pesan masuk dari ${sender}. ${text}`;
  if (msg.data.is_group) {
    chatName = await resolveGroupName(msg.data.chat);
    logLine = `[${chatName}] ${sender}: ${text}`;
    spoken = `Pesan masuk di grup ${chatName} dari ${sender}. ${text}`;
  }

  appendChatMessage(chatName, msg.data.chat, msg.data.is_group ? `${sender}: ${text}` : text);
  pushLog(logLine, "in");

  if (settings.value?.autoReadIncoming) {
    await speakState(settings.value, spoken).catch((e) => pushLog(`tts failed: ${e}`, "system"));
  }
}

/** Instant, offline resolution against everything the stream has seen this
 * run. `groupsOnly` keeps "grup keluarga" from resolving to a person whose
 * name happens to contain it. Scoring (exact > whole word > substring >
 * edit distance) lives in lib/contactMatch.ts, shared with the live-search
 * fallback below and with the Rust side's `search_contact` tool. */
function resolveChat(spokenName: string, groupsOnly = false): ChatEntry | undefined {
  const entries = [...knownChats.entries()]
    .filter(([, entry]) => !groupsOnly || entry.jid.endsWith("@g.us"))
    .map(([name, entry]) => ({ name, entry }));
  return bestMatch(spokenName, entries, (c) => c.name)?.entry;
}

/** Resolves a spoken name to a chat, asking waxum when the local cache
 * doesn't have it -- without the search fallback "balas ke budi" only ever
 * worked for people who happened to message us since the app started. A
 * hit is cached under the name the server reported, so the next command
 * resolves offline. */
async function resolveContact(
  spokenName: string,
  groupsOnly = false,
): Promise<ChatEntry | undefined> {
  const local = resolveChat(spokenName, groupsOnly);
  if (local) return local;
  const s = settings.value;
  const query = spokenName.trim();
  if (!s || !query) return undefined;
  try {
    const found: ContactCandidate[] = extractContacts(await waxumSearch(s, query)).filter(
      (c) => !groupsOnly || c.jid.endsWith("@g.us"),
    );
    // The server already filtered by the query, so its first hit is a
    // reasonable answer when no name scores high enough on its own.
    const hit = bestMatch(query, found, (c) => c.name) ?? found[0];
    if (!hit) return undefined;
    const entry: ChatEntry = { jid: hit.jid, messages: [] };
    knownChats.set(hit.name.toLowerCase(), entry);
    return entry;
  } catch (e) {
    pushLog(`pencarian kontak gagal: ${e}`, "system");
    return undefined;
  }
}

/** The most recently active group -- "cek pesan di grup ini". */
function currentGroup(): ChatEntry | undefined {
  if (!lastGroupJid) return undefined;
  return [...knownChats.values()].find((e) => e.jid === lastGroupJid);
}

/** Latest messages straight from waxum for one chat, oldest-first, merged
 * into the local cache so later commands and the AI path see them too. The
 * cache only ever holds what arrived while the app was running, so a chat
 * that has been quiet since before launch would otherwise read as empty. */
async function fetchChatLines(s: Settings, jid: string): Promise<string[]> {
  try {
    const lines = chronological(extractMessages(await waxumChatMessages(s, jid, 10))).map(
      messageLine,
    );
    const cached = [...knownChats.values()].find((e) => e.jid === jid);
    if (cached && lines.length) cached.messages = lines.slice(-HISTORY_PER_CHAT);
    return lines;
  } catch (e) {
    pushLog(`gagal memuat pesan: ${e}`, "system");
    return [];
  }
}

/** Wake-word gate, Siri/Alexa-style: the realtime mic is always
 * transcribing (see RealtimeVoice), but a transcript only reaches the
 * command pipeline if it opens with "Hey Jarvis" (plus the handful of
 * variants STT tends to mishear it as). Hearing the wake word triggers a
 * short spoken ack and opens an `AWAKE_WINDOW_MS` window during which the
 * NEXT transcript is treated as the actual command -- a two-step
 * wake-then-listen flow, not a single "wake word + command" sentence. */
const WAKE_WORDS = ["hey jarvis", "hei jarvis", "hai jarvis", "ok jarvis", "oke jarvis"];
const AWAKE_WINDOW_MS = 8000;
const awaitingCommand = ref(false);
let awakeTimer: ReturnType<typeof setTimeout> | null = null;

function matchWakeWord(text: string): boolean {
  const norm = text.trim().toLowerCase().replace(/[.,!?]/g, "");
  return WAKE_WORDS.some((w) => norm === w || norm.startsWith(`${w} `) || norm.includes(` ${w}`));
}

function clearAwakeTimer() {
  if (awakeTimer) {
    clearTimeout(awakeTimer);
    awakeTimer = null;
  }
}

async function onTranscript(raw: string) {
  const s = settings.value;
  if (!s) return;

  if (!awaitingCommand.value) {
    if (!matchWakeWord(raw)) return; // ignored -- no wake word, not a command attempt
    pushLog(raw, "out");
    pushLog('wake word terdeteksi, menunggu perintah…', "system");
    await speakState(s, "Ya?");
    awaitingCommand.value = true;
    clearAwakeTimer();
    awakeTimer = setTimeout(() => {
      awaitingCommand.value = false;
      pushLog("tidak ada perintah, kembali standby.", "system");
    }, AWAKE_WINDOW_MS);
    return;
  }

  clearAwakeTimer();
  awaitingCommand.value = false;
  await processCommand(s, raw);
}

/** The actual command pipeline: run once a transcript arrives inside the
 * awake window, or immediately for a typed command. */
async function processCommand(s: Settings, raw: string) {
  pushLog(raw, "out");
  transientState.value = "thinking";

  try {
    const intent = parseCommand(raw);

    // The fixed shapes are handled locally and instantly; only what they
    // cannot express reaches the model. Sending *every* transcript to the
    // AI whenever one was configured put a network round trip in front of
    // "list sesi" and turned a deterministic command into a failure the
    // moment the endpoint was slow or down -- exactly what the regex
    // parser exists to avoid. handleWithAi() is documented as the fallback
    // for unparsed speech, and now behaves like one.
    if (intent.kind === "unknown") {
      await handleWithAi(s, raw);
      return;
    }

    switch (intent.kind) {
      case "read_latest": {
        const entry = intent.from
          ? await resolveContact(intent.from)
          : [...knownChats.values()].at(-1);
        if (!entry) {
          await speakState(s, "Tidak ada pesan yang sesuai dalam basis data.");
          break;
        }
        // A named chat is read from waxum directly -- the local cache only
        // holds what arrived this run, so "baca pesan dari budi" used to
        // answer "no such message" for anyone who had not just messaged us.
        let lines = entry.messages;
        if (intent.from) {
          const live = await fetchChatLines(s, entry.jid);
          if (live.length) lines = live;
        }
        await speakState(s, lines.at(-1) ?? "Tidak ada isi pesan.");
        break;
      }
      case "read_group": {
        const entry = intent.group
          ? await resolveContact(intent.group, true)
          : currentGroup();
        if (!entry) {
          await speakState(
            s,
            intent.group
              ? `Grup ${intent.group} tidak ditemukan dalam percakapan aktif.`
              : "Belum ada grup yang aktif.",
          );
          break;
        }
        const live = await fetchChatLines(s, entry.jid);
        const lines = live.length ? live : entry.messages;
        const name = await resolveGroupName(entry.jid);
        const latest = lines.at(-1);
        await speakState(s, latest ? `Di ${name}: ${latest}` : `Belum ada pesan di ${name}.`);
        break;
      }
      case "send_message": {
        const entry = await resolveContact(intent.to);
        if (!entry) {
          await speakState(s, `Kontak ${intent.to} tidak ditemukan dalam percakapan aktif.`);
          pushLog(`unresolved contact: "${intent.to}"`, "system");
          break;
        }
        try {
          await waxumSendText(s, entry.jid, intent.text);
          pushLog(`sent to ${intent.to}: ${intent.text}`, "system");
          await speakState(s, `Pesan telah dikirim kepada ${intent.to}.`);
        } catch (e) {
          await speakState(s, "Pengiriman pesan gagal.");
          pushLog(`send failed: ${e}`, "system");
        }
        break;
      }
      case "list_sessions":
        await speakState(s, `${knownChats.size} percakapan aktif terdeteksi.`);
        break;
    }
  } finally {
    // speakState() clears this on its way out; this is the safety net for a
    // branch that throws (a failed lookup) before it ever speaks, which
    // otherwise left the robot face stuck on "thinking" for good.
    if (transientState.value === "thinking") transientState.value = null;
  }
}

/** Fallback for anything the fixed regex patterns don't cover — free-form
 * questions like "halo ada pesan apa aja" have no fixed shape, so this
 * hands the transcript to the configured LLM as a real conversation turn.
 * Contact resolution and the actual send now happen server-side via the
 * model's own search_contact/send_message tool calls — this side no longer
 * decides who "Randy" is with a substring check, it just hands over the
 * known contacts as searchable data and speaks whatever the model settles
 * on. Reply streams in live (see onAiStream below) before this resolves. */
async function handleWithAi(s: Settings, transcript: string) {
  if (!aiConfigured(s)) {
    pushLog(`unrecognized command: "${transcript}"`, "system");
    await speakState(
      s,
      "Perintah tidak dikenali. Atur AI di pengaturan untuk mode obrolan bebas.",
    );
    return;
  }
  const contacts: AiContact[] = [...knownChats.entries()].map(([name, e]) => ({
    name,
    jid: e.jid,
    recent: e.messages,
  }));

  streamingReply.value = "";
  try {
    const reply = await aiConverse(s, transcript, contacts);
    streamingReply.value = "";
    pushLog(reply, "in");
    await speakState(s, reply);
  } catch (e) {
    streamingReply.value = "";
    pushLog(`ai request failed: ${e}`, "system");
    await speakState(s, "Modul AI tidak merespons.");
  }
}

onMounted(async () => {
  await boot();
  unlistenMessage = await onIncomingMessage(handleIncoming);
  unlistenStatus = await onStreamStatus((m) => (statusLine.value = m));
  unlistenAiStream = await onAiStream((chunk) => {
    streamingReply.value += chunk;
  });
  unlistenAiTool = await onAiTool((call) => {
    pushLog(`ai tool: ${call.name}(${JSON.stringify(call.arguments)})`, "system");
  });
});

/** Keeps the newest line visible. Only follows when the user is already at
 * the bottom, so scrolling back through history isn't yanked away by the
 * next incoming message. */
watch([() => log.length, streamingReply], async () => {
  await nextTick();
  const el = logEl.value;
  if (!el) return;
  const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  if (distanceFromBottom < 48) el.scrollTop = el.scrollHeight;
});

onUnmounted(() => {
  unlistenMessage?.();
  unlistenStatus?.();
  unlistenAiStream?.();
  unlistenAiTool?.();
  clearAwakeTimer();
});
</script>

<template>
  <div v-if="!ready" class="h-screen flex items-center justify-center text-white/40 text-sm">
    loading…
  </div>

  <SetupView
    v-else-if="showSettings"
    :model-value="settings!"
    @save="onSaveSettings" />

  <div v-else class="h-screen flex flex-col hud-frame overflow-hidden">
    <span class="hud-corner-tr" />
    <span class="hud-corner-br" />

    <header class="flex items-center justify-between px-4 h-11 shrink-0">
      <div class="text-[10px] font-semibold tracking-[0.3em] uppercase hud-glow-text">waxum // agent</div>
      <div class="flex items-center gap-3">
        <LiveClock />
        <button class="text-[10px] uppercase tracking-widest text-hud-400/50 hover:text-hud-400" @click="showSettings = true">
          config
        </button>
      </div>
    </header>
    <div class="cyber-line" />

    <div class="shrink-0 pt-4 pb-2 flex flex-col items-center">
      <RobotFace :state="assistantState" />
      <div
        class="mt-2 text-[10px] uppercase tracking-wide max-w-[85%] text-center truncate"
        :class="sessionReady ? 'text-hud-400/50' : 'text-cyber-pink'">
        &gt; {{ statusLine }}
      </div>
      <div v-if="awaitingCommand" class="mt-1 text-[9px] uppercase tracking-widest text-cyber-pink hud-glow-text">
        mendengarkan perintah…
      </div>
    </div>

    <AnimatePresence>
      <motion.div
        v-if="!sessionReady"
        :initial="{ opacity: 0, y: -8 }"
        :animate="{ opacity: 1, y: 0 }"
        :exit="{ opacity: 0, y: -8 }"
        class="mx-4 mb-2 card p-3 flex items-center justify-between gap-3 shrink-0">
        <p class="text-xs text-hud-400/70">
          Sesi belum tertaut. Pindai kode QR untuk mengaktifkan modul WhatsApp.
        </p>
        <button class="btn-primary shrink-0 text-xs" @click="showPairing = true">Pair now</button>
      </motion.div>
    </AnimatePresence>

    <div class="cyber-line" />
    <main
      ref="logEl"
      class="flex-1 overflow-y-auto px-4 py-2 flex flex-col gap-1.5 font-mono text-xs">
      <AnimatePresence>
        <motion.div
          v-for="entry in log"
          :key="entry.id"
          :initial="{ opacity: 0, x: -8 }"
          :animate="{ opacity: 1, x: 0 }"
          :transition="{ duration: 0.18 }"
          class="flex gap-2 items-baseline"
          :class="{
            'text-hud-300': entry.kind === 'in',
            'text-hud-500/80': entry.kind === 'out',
            'text-hud-400/25 text-[10px]': entry.kind === 'system',
          }">
          <span class="text-hud-400/30 shrink-0 tabular-nums">{{ entry.time }}</span>
          <span
            class="shrink-0 uppercase tracking-wide"
            :class="{
              'text-cyber-pink/70': entry.kind === 'in',
              'text-hud-500': entry.kind === 'out',
              'opacity-0 w-0': entry.kind === 'system',
            }">
            {{ entry.kind === 'in' ? '< RX' : entry.kind === 'out' ? '> TX' : '' }}
          </span>
          <span class="min-w-0 break-words">{{ entry.text }}</span>
        </motion.div>
      </AnimatePresence>
      <p v-if="log.length === 0 && sessionReady" class="text-center text-hud-400/30 text-xs mt-6 uppercase tracking-wide">
        Standby. Ucapkan "baca pesan" atau ketik perintah di bawah.
      </p>
      <p v-if="streamingReply" class="flex gap-2 items-baseline text-hud-300/70 italic">
        <span class="text-hud-400/30 shrink-0 uppercase tracking-wide text-[10px]">…</span>
        <span class="min-w-0 break-words">{{ streamingReply }}</span>
      </p>
    </main>
    <div class="cyber-line" />

    <form class="flex gap-2 px-4 pt-2 shrink-0" @submit.prevent="submitTyped">
      <input
        v-model="typedCommand"
        class="input flex-1"
        placeholder="ketik perintah…"
        :disabled="!sessionReady" />
      <motion.button
        type="submit"
        class="btn-ghost shrink-0"
        :while-press="{ scale: 0.94 }"
        :disabled="!sessionReady || !typedCommand.trim()">
        Send
      </motion.button>
    </form>

    <VoiceBar
      :settings="settings!"
      :active="sessionReady && !busy"
      :speaking="transientState === 'speaking'"
      @transcript="onTranscript"
      @error="(e) => pushLog(e, 'system')"
      @listening="onListeningChange" />

    <AnimatePresence>
      <PairingModal
        v-if="showPairing"
        :base-url="settings!.baseUrl"
        :token="settings!.token"
        :session-id="settings!.sessionId"
        @close="showPairing = false"
        @paired="onPairedFromMain" />
    </AnimatePresence>
  </div>
</template>
