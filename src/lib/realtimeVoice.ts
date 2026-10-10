import { invoke } from "@tauri-apps/api/core";
import type { Settings } from "./types";

export type RealtimeEvent =
  | { kind: "partial"; text: string }
  | { kind: "final"; text: string }
  | { kind: "error"; message: string }
  | { kind: "closed" };

/**
 * Continuous-listening mode via ElevenLabs' realtime STT websocket
 * (wss://api.elevenlabs.io/v1/speech-to-text/realtime) — mic audio
 * streams out as raw 16kHz PCM for as long as the session is open, and
 * the server's VAD decides when an utterance ends and commits a
 * transcript, instead of push-to-talk's record-then-upload cycle.
 *
 * The realtime socket rejects a raw `xi-api-key` outright, on the query
 * string or as a header — confirmed against the live endpoint, it always
 * answers with an `auth_error` frame. It only accepts a short-lived
 * single-use token minted via `POST /v1/single-use-token/realtime_scribe`,
 * so `start()` asks the Rust side to mint one (keeping the real API key
 * out of the websocket URL entirely) before opening the connection.
 */
export class RealtimeVoice {
  private ws: WebSocket | null = null;
  private audioCtx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private mute: GainNode | null = null;
  private stream: MediaStream | null = null;
  private readonly sampleRate = 16000;

  /** Bumped by every `start()` and by `stop()`. `start()` awaits a token
   * mint and a websocket handshake before it owns any resources, so a stop()
   * (or a second start()) landing in that window used to find nothing to
   * tear down and then watch start() finish anyway -- leaving a live
   * websocket and a live mic stream behind that nothing had a handle on any
   * more. A plain boolean is wrong here: the next start() would clear it
   * again and un-cancel the first one. A generation is per-start. */
  private generation = 0;

  /** True while the assistant's own TTS is playing — audio capture keeps
   * running (so the websocket doesn't idle-timeout) but chunks are not
   * sent, otherwise the mic hears the assistant's own voice out of the
   * speakers and transcribes it as a new command, which is exactly the
   * "talking to itself" loop this exists to prevent. Real voice-mode
   * assistants (Gemini, ChatGPT) do the same half-duplex turn-taking. */
  private suspended = false;

  setSuspended(value: boolean): void {
    this.suspended = value;
  }

  async start(settings: Settings, onEvent: (e: RealtimeEvent) => void): Promise<void> {
    const generation = ++this.generation;
    const token = await invoke<string>("elevenlabs_mint_realtime_token", {
      apiKey: settings.elevenLabsApiKey,
    });
    if (generation !== this.generation) return;
    const url =
      `wss://api.elevenlabs.io/v1/speech-to-text/realtime` +
      `?token=${encodeURIComponent(token)}` +
      `&sample_rate=${this.sampleRate}&commit_strategy=vad`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.message_type === "partial_transcript" && msg.text) {
          onEvent({ kind: "partial", text: msg.text });
        } else if (msg.message_type === "committed_transcript" && msg.text?.trim()) {
          onEvent({ kind: "final", text: msg.text.trim() });
        }
      } catch {
        // malformed/unrecognized frame, ignore
      }
    };
    ws.onerror = () => onEvent({ kind: "error", message: "realtime connection error" });
    ws.onclose = () => onEvent({ kind: "closed" });

    // addEventListener (not ws.onopen/onerror/onclose) so the connect-time
    // handlers don't clobber the runtime ones set above. Rejecting the
    // moment the socket dies -- instead of only on the 8s timeout -- is
    // what lets the caller retry promptly instead of sitting dead for
    // eight seconds first.
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => settle(() => resolve());
      const onError = () => settle(() => reject(new Error("socket error before it opened")));
      const onClose = () => settle(() => reject(new Error("socket closed before it opened")));
      const settle = (done: () => void) => {
        clearTimeout(timeout);
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
        ws.removeEventListener("close", onClose);
        done();
      };
      const timeout = setTimeout(
        () => settle(() => {
          ws.close();
          reject(new Error("timed out connecting"));
        }),
        8000,
      );
      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onError);
      ws.addEventListener("close", onClose);
    });

    if (generation !== this.generation) {
      ws.close();
      this.ws = null;
      return;
    }

    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
    if (generation !== this.generation) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
      ws.close();
      this.ws = null;
      return;
    }
    // Anything that throws from here on (permission revoked between the two
    // awaits, no audio output device) used to leave the socket open and the
    // mic live for whoever called start() to notice.
    let audioCtx: AudioContext;
    try {
      audioCtx = new AudioContext();
    } catch (e) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
      ws.close();
      this.ws = null;
      throw e;
    }
    this.audioCtx = audioCtx;
    this.source = audioCtx.createMediaStreamSource(this.stream);
    this.processor = audioCtx.createScriptProcessor(4096, 1, 1);
    // ScriptProcessorNode only fires onaudioprocess once connected through
    // to a destination — route through a silent gain node so the mic is
    // never actually monitored back out the speakers.
    this.mute = audioCtx.createGain();
    this.mute.gain.value = 0;

    this.processor.onaudioprocess = (e) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.suspended) return;
      const input = e.inputBuffer.getChannelData(0);
      const audioBase64 = downsampleAndEncode(input, audioCtx.sampleRate, this.sampleRate);
      this.ws.send(
        JSON.stringify({
          message_type: "input_audio_chunk",
          audio_base_64: audioBase64,
          sample_rate: this.sampleRate,
        }),
      );
    };

    this.source.connect(this.processor);
    this.processor.connect(this.mute);
    this.mute.connect(audioCtx.destination);
  }

  stop(): void {
    this.generation += 1;
    this.processor?.disconnect();
    this.source?.disconnect();
    this.mute?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.audioCtx?.close().catch(() => {});
    this.ws?.close();
    this.processor = null;
    this.source = null;
    this.mute = null;
    this.stream = null;
    this.audioCtx = null;
    this.ws = null;
  }
}

function downsampleAndEncode(input: Float32Array, inRate: number, outRate: number): string {
  const ratio = inRate / outRate;
  const outLength = Math.floor(input.length / ratio);
  const pcm16 = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const sample = input[Math.floor(i * ratio)] ?? 0;
    const clamped = Math.max(-1, Math.min(1, sample));
    pcm16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  const bytes = new Uint8Array(pcm16.buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
