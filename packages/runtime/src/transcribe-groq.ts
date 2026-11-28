/**
 * Voice notes to text with Whisper, hosted by Groq (free plan available:
 * console.groq.com). Only turns speech into text; the main model does the
 * thinking.
 */

export interface AudioIn {
  base64: string;
  mimetype: string;
}

/** Writes out what was said in a voice note. Throws when it can't. */
export type Transcriber = (audio: AudioIn) => Promise<string>;

const EXT: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
  "audio/flac": "flac",
};

export function createGroqTranscriber(opts: {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  baseUrl?: string;
  fetch?: typeof fetch;
}): Transcriber {
  const model = opts.model?.trim() || "whisper-large-v3-turbo";
  const url = `${(opts.baseUrl ?? "https://api.groq.com/openai/v1").replace(/\/$/, "")}/audio/transcriptions`;
  const doFetch = opts.fetch ?? fetch;
  return async (audio) => {
    const type = audio.mimetype.split(";")[0]!.trim().toLowerCase();
    const form = new FormData();
    form.append("file", new Blob([Buffer.from(audio.base64, "base64")], { type }), `voice-note.${EXT[type] ?? "ogg"}`);
    form.append("model", model);
    form.append("response_format", "json");
    form.append("temperature", "0");
    // An example in the style we want: Hindi and English mixed, in Latin letters.
    form.append("prompt", "Haan, Mohan ka quotation bhej do. Site visit kal 3 baje hai, follow-up Monday ko.");
    const res = await doFetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${opts.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
    const body = (await res.json().catch(() => ({}))) as { text?: string; error?: { message?: string } };
    if (!res.ok) throw new Error(`Groq: ${body.error?.message ?? `HTTP ${res.status}`}`);
    return String(body.text ?? "").trim();
  };
}
