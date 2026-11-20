// src/services/LiveIntakeService.ts
//
// Live dictation for the vet's Basic Examination form.
//
// How it works, in order:
//   1. Ask the browser for the microphone.
//   2. Ask our Supabase Edge Function ("live-token") for a short-lived token.
//   3. Open a Gemini Live session with that token and describe one tool the
//      model may use: update_exam_field.
//   4. Stream microphone audio to Gemini.
//   5. Whenever Gemini hears a finding it "calls" the tool. That is just a
//      message to us saying which box to fill and with what. We fill the box.
//
// Gemini never touches the form or the database. It only decides WHEN to call
// the tool and WHAT to pass. Our code does the rest. This is "function calling".

import { GoogleGenAI, Modality, Type } from "@google/genai";
import type {
  FunctionDeclaration,
  LiveConnectConfig,
  LiveServerMessage,
  Session,
} from "@google/genai";

import {
  LIVE_INTAKE_FIELD_LABELS,
  LIVE_INTAKE_FIELDS,
  parseLiveIntakeUpdate,
  type LiveIntakeUpdate,
} from "@/lib/liveIntakeFields";
import { supabase, supabasePublishableKey } from "@/lib/supabase";
import type { BasicExaminationForm } from "@/services/MedicalRecordService";

// The current Live model. If Google renames it, this is the only line to change.
// Check: https://ai.google.dev/gemini-api/docs/live-guide
export const LIVE_MODEL = "gemini-3.8-live";

// Google's docs say ephemeral tokens use v1beta; the SDK's own notes say
// v1alpha. We try them in this order and remember whichever one works.
const API_VERSIONS = ["v1beta", "v1alpha"] as const;
type ApiVersion = (typeof API_VERSIONS)[number];
let workingApiVersion: ApiVersion | null = null;

const TOOL_NAME = "update_exam_field";
const MAX_RECONNECT_ATTEMPTS = 3;
const SHORT_LIVED_MS = 5_000;
const STOP_GRACE_MS = 2_500;

export type LiveIntakeStatus =
  | "connecting"
  | "listening"
  | "reconnecting"
  | "stopped";

export type LiveIntakeOptions = {
  /** Returns the form as it is right now (so Gemini knows what is filled). */
  getForm: () => BasicExaminationForm;
  /** Called every time Gemini wants a box filled. */
  onUpdate: (update: LiveIntakeUpdate) => void;
  /** Called with pieces of what the vet said (live captions). */
  onTranscript?: (text: string) => void;
  onStatus?: (status: LiveIntakeStatus) => void;
  /** Called if listening stops because of a problem. */
  onError?: (message: string) => void;
};

export type LiveIntakeHandle = {
  /** Stops the microphone and closes the session. Safe to call twice. */
  stop: () => void;
};

// ---------------------------------------------------------------------------
// The tool Gemini can call
// ---------------------------------------------------------------------------

const UPDATE_FIELD_TOOL: FunctionDeclaration = {
  name: TOOL_NAME,
  description:
    "Record one finding the veterinarian just stated on the hamster examination form. " +
    "Call it once per finding, as soon as the finding is stated.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      field: {
        type: Type.STRING,
        enum: [...LIVE_INTAKE_FIELDS],
        description:
          "Which box to fill. weight = body weight in grams. temperature = body temperature in degrees Celsius. " +
          "heartRate = beats per minute. symptoms = signs of illness, as a short comma-separated list. " +
          "physicalExaminationNotes = observations from the physical exam (coat, skin, eyes, teeth, posture, hydration, breathing, lumps). " +
          "diagnosis = the vet's stated diagnosis or assessment. treatment = medication, care plan or follow-up the vet states.",
      },
      value: {
        type: Type.STRING,
        description:
          "The finding in the vet's own words, kept short. For weight, temperature and heartRate give only the number.",
      },
      mode: {
        type: Type.STRING,
        enum: ["append", "replace"],
        description:
          "Use 'replace' only when the vet corrects something said earlier. Otherwise use 'append'.",
      },
    },
    required: ["field", "value"],
  },
};

function buildSystemInstruction(form: BasicExaminationForm): string {
  const filled = LIVE_INTAKE_FIELDS.filter((field) => form[field].trim() !== "")
    .map((field) => `- ${LIVE_INTAKE_FIELD_LABELS[field]}: ${form[field].trim()}`)
    .join("\n");

  return [
    "You are a silent scribe for a veterinarian who is examining a hamster and speaking findings out loud.",
    `Your only job is to call the ${TOOL_NAME} tool each time the vet states a finding that belongs on the examination form.`,
    "Rules:",
    "- Record only what the vet actually says. Never guess, infer or add medical advice.",
    "- Ignore small talk, talk aimed at the pet owner, and anything that is not an examination finding.",
    "- Convert units: weight to grams, temperature to degrees Celsius, heart rate to beats per minute.",
    "- If the vet corrects an earlier statement, call the tool again with mode 'replace'.",
    "- Do not record something that is already on the form unless the vet changes it.",
    "- Do not speak, greet, confirm or ask questions. Stay silent and only call the tool.",
    filled
      ? `Already on the form:\n${filled}`
      : "The form is currently empty.",
  ].join("\n");
}

function buildConfig(form: BasicExaminationForm): LiveConnectConfig {
  return {
    // Live models can only answer with audio. We simply never play it.
    responseModalities: [Modality.AUDIO],
    systemInstruction: buildSystemInstruction(form),
    tools: [{ functionDeclarations: [UPDATE_FIELD_TOOL] }],
    // Gives us text of what the vet said, for the live captions.
    inputAudioTranscription: {},
    // Lets a long exam keep going instead of ending when the context fills up.
    contextWindowCompression: { slidingWindow: {} },
  };
}

// ---------------------------------------------------------------------------
// Getting a token from our Edge Function
// ---------------------------------------------------------------------------

class LiveTokenError extends Error {
  /** true = retrying will not help (not signed in, function missing, ...). */
  fatal: boolean;

  constructor(message: string, fatal: boolean) {
    super(message);
    this.name = "LiveTokenError";
    this.fatal = fatal;
  }
}

async function fetchLiveToken(apiVersion: ApiVersion): Promise<string> {
  const { data: sessionData, error: sessionError } =
    await supabase.auth.getSession();
  if (sessionError) throw new LiveTokenError(sessionError.message, true);
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) {
    throw new LiveTokenError("Sign in to use live dictation.", true);
  }

  const { data, error } = await supabase.functions.invoke<{
    token?: string;
    error?: string;
  }>("live-token", {
    body: { apiVersion },
    headers: {
      apikey: supabasePublishableKey,
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (error) {
    let message = error instanceof Error ? error.message : String(error);
    let status = 0;
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) {
      status = context.status;
      let bodyError: unknown;
      try {
        bodyError = ((await context.clone().json()) as { error?: unknown })
          ?.error;
      } catch {
        // The body was not JSON. Keep the default message.
      }
      if (typeof bodyError === "string" && bodyError) {
        message = bodyError;
      } else if (status === 404) {
        message =
          'The "live-token" Edge Function is not deployed in this Supabase project.';
      } else if (status === 401) {
        message =
          'Supabase rejected the request (401). In the live-token function\'s settings, turn off "Verify JWT with legacy secret".';
      }
    }
    // 502 means Gemini refused this API version. Another version may work.
    throw new LiveTokenError(message, status !== 502);
  }

  if (!data?.token) {
    throw new LiveTokenError(
      data?.error || "The live-token function did not return a token.",
      true,
    );
  }
  return data.token;
}

// ---------------------------------------------------------------------------
// Microphone -> raw audio chunks
// ---------------------------------------------------------------------------

// This small program runs on the browser's audio thread. It turns microphone
// samples (decimals from -1 to 1) into 16-bit whole numbers, which is the
// "PCM" format the Live API expects, and posts a chunk about every 100 ms.
// It is kept as text so no extra file has to be hosted.
export const PCM_WORKLET_SOURCE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunkSize = Math.max(128, Math.round(sampleRate / 10));
    this.buffer = new Int16Array(this.chunkSize);
    this.index = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i]));
      this.buffer[this.index++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.index === this.chunkSize) {
        const copy = this.buffer.slice();
        this.port.postMessage(copy.buffer, [copy.buffer]);
        this.index = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-capture", PcmCaptureProcessor);
`;

/** Raw bytes -> base64 text (the Live API wants audio as base64). */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function describeMicrophoneError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone access was blocked. Allow the microphone for this site in your browser, then try again.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No microphone was found on this device.";
  }
  if (name === "NotReadableError") {
    return "The microphone is being used by another app.";
  }
  return error instanceof Error
    ? `Could not start the microphone: ${error.message}`
    : "Could not start the microphone.";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// The main function
// ---------------------------------------------------------------------------

type Connection = {
  session: Session | null;
  /** true from "setup finished" until the connection closes. */
  live: boolean;
  openedAt: number;
};

/**
 * Starts live dictation. Resolves once Gemini is listening.
 * Rejects (with a readable message) if the microphone or connection fails.
 */
export async function startLiveIntake(
  options: LiveIntakeOptions,
): Promise<LiveIntakeHandle> {
  const { getForm, onUpdate, onTranscript, onStatus, onError } = options;

  onStatus?.("connecting");

  // ---- 1. Microphone first, so a slow permission pop-up cannot expire the token.
  if (!navigator.mediaDevices?.getUserMedia) {
    onStatus?.("stopped");
    throw new Error(
      "This browser cannot use the microphone here. Open the site over https (or on localhost).",
    );
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (error) {
    onStatus?.("stopped");
    throw new Error(describeMicrophoneError(error));
  }

  let stopped = false;
  let reconnecting = false;
  let shortLivedCloses = 0;
  let current: Connection | null = null;
  let audioContext: AudioContext | null = null;

  function cleanupAudio() {
    stream.getTracks().forEach((track) => track.stop()); // turns off the mic light
    const context = audioContext;
    audioContext = null;
    if (context && context.state !== "closed") {
      void context.close().catch(() => undefined);
    }
  }

  function closeQuietly(connection: Connection | null) {
    if (!connection?.session || !connection.live) return;
    connection.live = false;
    try {
      connection.session.close();
    } catch {
      // Already closed.
    }
  }

  function fail(message: string) {
    if (stopped) return;
    stopped = true;
    cleanupAudio();
    closeQuietly(current);
    onStatus?.("stopped");
    onError?.(message);
  }

  function handleMessage(connection: Connection, message: LiveServerMessage) {
    if (!connection.live) return;

    // a) Gemini wants one or more boxes filled.
    const calls = message.toolCall?.functionCalls ?? [];
    if (calls.length > 0) {
      for (const call of calls) {
        if (call.name !== TOOL_NAME) continue;
        const update = parseLiveIntakeUpdate(call.args);
        if (update) onUpdate(update);
      }
      // Tell Gemini "done" so it keeps listening.
      try {
        connection.session?.sendToolResponse({
          functionResponses: calls.map((call) => ({
            id: call.id,
            name: call.name,
            response: { result: "ok" },
          })),
        });
      } catch (error) {
        console.warn("Live intake: could not send tool response:", error);
      }
    }

    // b) Live captions of what the vet said.
    const caption = message.serverContent?.inputTranscription?.text;
    if (caption) onTranscript?.(caption);

    // c) Gemini warns before it ends a connection (about every 10 minutes).
    //    Open a fresh one so the vet can keep talking.
    if (message.goAway && connection === current) void reconnect();
  }

  function handleClose(connection: Connection, event: CloseEvent) {
    const wasLive = connection.live;
    connection.live = false;
    if (!wasLive || connection !== current || stopped) return;

    // Stop a "connect, drop, connect, drop" loop instead of spinning forever.
    if (Date.now() - connection.openedAt < SHORT_LIVED_MS) {
      shortLivedCloses += 1;
    } else {
      shortLivedCloses = 0;
    }
    if (shortLivedCloses >= MAX_RECONNECT_ATTEMPTS) {
      fail(
        `Gemini keeps closing the live session (code ${event.code}${event.reason ? `: ${event.reason}` : ""}).`,
      );
      return;
    }
    void reconnect();
  }

  async function connect(): Promise<Connection> {
    const versions: ApiVersion[] = workingApiVersion
      ? [
          workingApiVersion,
          ...API_VERSIONS.filter((version) => version !== workingApiVersion),
        ]
      : [...API_VERSIONS];
    const problems: string[] = [];

    for (const apiVersion of versions) {
      // A new object per try, so a late "close" from a failed try is ignored.
      const connection: Connection = { session: null, live: false, openedAt: 0 };
      try {
        const token = await fetchLiveToken(apiVersion);
        const ai = new GoogleGenAI({
          apiKey: token,
          httpOptions: { apiVersion },
        });
        connection.session = await ai.live.connect({
          model: LIVE_MODEL,
          config: buildConfig(getForm()),
          callbacks: {
            onmessage: (message) => handleMessage(connection, message),
            onerror: (event) =>
              console.warn("Live intake: connection error:", event.message),
            onclose: (event) => handleClose(connection, event),
          },
        });
        connection.live = true;
        connection.openedAt = Date.now();
        workingApiVersion = apiVersion;
        return connection;
      } catch (error) {
        if (error instanceof LiveTokenError && error.fatal) throw error;
        problems.push(`${apiVersion}: ${errorMessage(error)}`);
      }
    }

    throw new Error(
      `Could not connect to Gemini Live (model ${LIVE_MODEL}). ${problems.join(" | ")}`,
    );
  }

  async function reconnect() {
    if (stopped || reconnecting) return;
    reconnecting = true;
    onStatus?.("reconnecting");
    const previous = current;

    try {
      let next: Connection | null = null;
      let lastError: unknown = null;
      for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
        if (stopped) break;
        try {
          next = await connect();
          break;
        } catch (error) {
          lastError = error;
          if (error instanceof LiveTokenError && error.fatal) break;
          await sleep(1_000 * attempt);
        }
      }

      if (stopped) {
        closeQuietly(next);
        return;
      }
      if (!next) {
        fail(`Live dictation stopped: ${errorMessage(lastError)}`);
        return;
      }

      current = next;
      closeQuietly(previous);
      onStatus?.("listening");
    } finally {
      reconnecting = false;
    }
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    cleanupAudio();

    const connection = current;
    if (connection?.live && connection.session) {
      try {
        // Tells Gemini the audio is over so it finishes the last sentence.
        connection.session.sendRealtimeInput({ audioStreamEnd: true });
      } catch {
        // Connection already gone.
      }
      // Leave the session open briefly so a last finding can still arrive.
      setTimeout(() => closeQuietly(connection), STOP_GRACE_MS);
    }
    onStatus?.("stopped");
  }

  // ---- 2 + 3. Token and Live session.
  try {
    current = await connect();
  } catch (error) {
    stopped = true;
    cleanupAudio();
    onStatus?.("stopped");
    throw error instanceof Error ? error : new Error(String(error));
  }

  // ---- 4. Stream the microphone into the session.
  try {
    const context = new AudioContext();
    audioContext = context;
    if (context.state === "suspended") await context.resume();

    const workletUrl = URL.createObjectURL(
      new Blob([PCM_WORKLET_SOURCE], { type: "application/javascript" }),
    );
    try {
      await context.audioWorklet.addModule(workletUrl);
    } finally {
      URL.revokeObjectURL(workletUrl);
    }

    const microphone = context.createMediaStreamSource(stream);
    const capture = new AudioWorkletNode(context, "pcm-capture");
    // We tell Gemini the real sample rate (often 48000); it resamples for us.
    const mimeType = `audio/pcm;rate=${context.sampleRate}`;

    capture.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      const connection = current;
      if (stopped || !connection?.live || !connection.session) return;
      try {
        connection.session.sendRealtimeInput({
          audio: { data: arrayBufferToBase64(event.data), mimeType },
        });
      } catch {
        // The connection dropped mid-send. reconnect() will take over.
      }
    };

    // A silent path to the speakers keeps the browser processing the audio.
    // The gain is 0, so the vet never hears themselves.
    const silence = context.createGain();
    silence.gain.value = 0;
    microphone.connect(capture);
    capture.connect(silence);
    silence.connect(context.destination);

    // If the microphone is unplugged, stop cleanly.
    stream.getAudioTracks().forEach((track) => {
      track.addEventListener("ended", () =>
        fail("The microphone was disconnected."),
      );
    });
  } catch (error) {
    stopped = true;
    cleanupAudio();
    closeQuietly(current);
    onStatus?.("stopped");
    throw new Error(`Could not start audio capture: ${errorMessage(error)}`);
  }

  if (stopped) {
    // fail() ran while we were setting up.
    throw new Error("Live dictation stopped before it could start.");
  }

  onStatus?.("listening");
  return { stop };
}
