<p align="center">
  <img src="https://waxum.imtaqin.id/img/logo.png" alt="waxum agent" width="120" />
</p>

<h1 align="center">waxum agent</h1>

<p align="center">
  Voice-driven WhatsApp assistant on top of <a href="https://github.com/imtaqin/waxum">waxum</a> — a Jarvis-style app that reads incoming messages aloud and lets you reply or manage chats by voice. Desktop and Android, one Tauri codebase.
</p>

---

## What it does

- Connects to a waxum instance — either a **remote URL** (self-hosted server) or a **bundled binary** you point it at (spawned as a local child process, talking to `127.0.0.1`).
- Streams incoming WhatsApp messages live over waxum's `/events/tail` SSE endpoint.
- **Reads incoming messages aloud** (ElevenLabs TTS) — on by default, toggle in settings.
- **Voice commands** over ElevenLabs' realtime STT websocket: the mic stays
  open and everything is transcribed, but only an utterance that opens with the
  wake word — **"hey jarvis"** — is treated as a command. Say the wake word, the
  app answers "Ya?", and the next thing you say is the command (8s window). The
  wake word is what stops a permanently-open mic from acting on overheard
  conversation; the on-screen hint says it out loud because there is otherwise
  no way to discover it.
  - "baca pesan" / "bacain pesan dari budi" — reads the latest message, optionally scoped to a contact
  - "cek pesan di grup ini" / "cek pesan di grup keluarga" — reads the latest message in a group
  - "balas ke budi bilang otw" / "kirim pesan ke budi bilang otw" — sends a text message
  - "list sesi" — how many active conversations the app has seen this run
- **Typed commands** — the box at the bottom takes the same commands as text and
  is *not* wake-word gated (there is nothing to gate when you typed it on
  purpose), which is also the only way to drive it on a machine with no mic.
- **Contacts resolve beyond what you have seen this run**: the chats the stream
  has shown are tried first (instant, offline), then waxum's stored messages, so
  "balas ke budi" works for someone who has not messaged you since launch, and
  "baca pesan dari budi" reads waxum's stored history for that chat instead of
  only what arrived while the app happened to be open.
- Design matches the rest of the waxum ecosystem (waxum-studio's charcoal/emerald palette, Geist font).

## Stack

Tauri v2 (Rust backend + Vue 3 / Tailwind frontend, one codebase for desktop and Android). Rust side owns the waxum REST client, the SSE bridge, the ElevenLabs client, and the bundled-binary process; the frontend owns settings, the voice UI, and a small regex-based command parser (`src/lib/commandParser.ts`) — commands here are a handful of fixed shapes, not open-ended NL, so no LLM in the loop for command parsing.

```
src/                    Vue frontend
├── App.vue               orchestrator: settings gate, message log, command pipeline
├── components/
│   ├── SetupView.vue        connection mode, waxum + ElevenLabs + AI settings
│   └── VoiceBar.vue         always-open realtime mic, mute, reconnect
└── lib/
    ├── settings.ts           tauri-plugin-store persistence
    ├── waxum.ts               typed wrappers around the Tauri commands
    ├── voice.ts               TTS playback
    ├── realtimeVoice.ts       ElevenLabs realtime STT websocket
    ├── commandParser.ts       transcript -> intent
    ├── contactMatch.ts        name scoring + waxum payload normalisation
    └── ai.ts                  AI settings, streaming and tool-call events

tests/                  node --test unit tests (npm test)

src-tauri/src/          Rust backend
├── waxum.rs               waxum REST client (status, sessions, send, search)
├── elevenlabs.rs          ElevenLabs TTS + STT (incl. realtime token minting)
├── events.rs              SSE tail -> Tauri events, with reconnect/backoff
├── pairing.rs             pairing run + QR/pair-code events
├── bundled.rs             spawn/kill a local waxum binary
├── download.rs            fetch/update that binary from GitHub releases
├── ai.rs                  OpenAI-compatible client + tool calls
├── linux_media.rs         enable mic access in the WebKitGTK webview
└── commands.rs            #[tauri::command] surface the frontend calls
```

## Setup

```bash
npm install
npm run tauri dev      # desktop
```

On first launch you land on the settings screen:

- **Remote URL mode** — waxum base URL (e.g. `https://waxum-api.example.com/api/v1`) + bearer token + session id.
- **Bundled binary mode** — leave the path empty and it auto-downloads the latest [waxum release](https://github.com/imtaqin/waxum/releases) for your OS/arch (linux-amd64/arm64, windows-amd64) into the app data dir and spawns it on `127.0.0.1:3451`; point it at your own binary instead if you'd rather not auto-download.
- ElevenLabs API key + voice id (defaults to voice `21m00Tcm4TlvDq8ikWAM` — swap for your own).

Both connections have a "Test" button before you save.

### Android

```bash
npm run tauri android init   # one-time, needs Android SDK + NDK installed
npm run tauri android dev
```

Bundled-binary mode is desktop-only (no child-process spawning on Android) — the Rust side already reflects this (`bundled.rs` uses `tokio::process::Command`, which is a no-op target on mobile); the settings screen should be pointed at remote URL mode on Android.

### Desktop system dependencies (Linux)

Tauri's Linux target needs `webkit2gtk-4.1` + `libsoup3` dev headers:

```bash
sudo dnf install webkit2gtk4.1-devel libsoup3-devel gtk3-devel librsvg2-devel   # Fedora
sudo apt install libwebkit2gtk-4.1-dev libsoup-3.0-dev libgtk-3-dev librsvg2-dev  # Debian/Ubuntu
```

### Microphone access (Linux)

WebKitGTK ships media streams disabled by default and never shows a
native permission prompt — every `getUserMedia()` call fails with
`NotAllowedError` unless the app explicitly enables it. `linux_media.rs`
handles this (enables `enable-media-stream`/`enable-webaudio` and
auto-allows `UserMediaPermissionRequest` on the WebView), no user
action needed. If the mic still doesn't capture anything after that
(silent audio, `OverconstrainedError`), it's GStreamer, not
permissions — the WebKit web process needs the `base`/`good` plugins
and PipeWire's GStreamer integration installed:

```bash
sudo dnf install gstreamer1-plugins-base gstreamer1-plugins-good pipewire-gstreamer   # Fedora
sudo apt install gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-pipewire  # Debian/Ubuntu
```

## Tests

```bash
npm test              # frontend: node --test over tests/
cargo test            # backend: unit tests in src-tauri/
```

The frontend tests use node's built-in runner (no test framework
installed) over the pure modules — the command parser and the
name-scoring/payload-normalising helpers in `src/lib/contactMatch.ts`.
Anything that needs a live Tauri runtime or a waxum server is not covered
there.

## Notes / known limitations (v1)

- The command parser is a fixed set of Indonesian regex patterns
  (`src/lib/commandParser.ts`), not free-form NL — extend the pattern
  lists there rather than reaching for an LLM unless open-ended commands
  become a real requirement. Those patterns are matched first and answered
  locally, with no network call: only a transcript that matches none of them
  goes to the configured AI endpoint. So "list sesi" never waits on a model,
  and never fails because the endpoint is slow or down.
- Contact resolution prefers names the app has actually seen, then falls
  back to waxum's `/messages/search` (`resolveContact()` in `App.vue`).
  When a name is genuinely ambiguous the highest-scoring candidate wins
  (exact > whole word > substring > edit distance, all in
  `src/lib/contactMatch.ts`) instead of the app asking which one you meant —
  so "balas ke budi" with two contacts called Budi can pick the wrong one.
- Auto-reconnect and backoff on the SSE stream is handled Rust-side
  (`events.rs`); the bundled-binary process is not auto-restarted if it
  crashes — restart it from settings.
- `linux_media.rs` only fixes microphone access on Linux. macOS's
  WKWebView has its own separate, still-unresolved mic permission bug
  in wry ([wry#1195](https://github.com/tauri-apps/wry/issues/1195),
  [tauri#11951](https://github.com/tauri-apps/tauri/issues/11951)) —
  `NSMicrophoneUsageDescription` alone is not enough; expect to need a
  similar manual workaround if voice input doesn't work on macOS.
  Windows (WebView2) prompts natively, no extra code needed.
