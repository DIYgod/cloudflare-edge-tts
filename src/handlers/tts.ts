import { createAudioStream } from "../lib/tts";
import { CORS_HEADERS, errorResponse } from "../lib/http";

type TtsBody = {
  text?: unknown;
  voice?: unknown;
};

function isJsonContentType(value: string) {
  const mediaType = value.split(";")[0]?.trim().toLowerCase();
  return mediaType === "application/json";
}

function parseBody(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("request body must be an object");
  }

  const { text, voice } = body as TtsBody;

  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error("text is required");
  }

  if (voice !== undefined) {
    if (typeof voice !== "string") {
      throw new Error("voice must be a string");
    }

    if (voice.trim().length === 0) {
      throw new Error("voice must be a non-empty string");
    }
  }

  return {
    text: text.trim(),
    voice: typeof voice === "string" ? voice.trim() : voice,
  };
}

async function primeAudioStream(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const firstChunk = await reader.read();
  let firstChunkConsumed = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!firstChunkConsumed) {
          firstChunkConsumed = true;

          if (firstChunk.done) {
            controller.close();
            return;
          }

          controller.enqueue(firstChunk.value);
          return;
        }

        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          return;
        }

        controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

export async function handleTts(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!isJsonContentType(contentType)) {
    return errorResponse(
      400,
      "INVALID_CONTENT_TYPE",
      "content-type must be application/json"
    );
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return errorResponse(
      400,
      "INVALID_REQUEST",
      "request body must be valid json"
    );
  }

  let parsed: ReturnType<typeof parseBody>;

  try {
    parsed = parseBody(body);
  } catch (error) {
    return errorResponse(
      400,
      "INVALID_REQUEST",
      error instanceof Error ? error.message : "request body must be valid json"
    );
  }

  try {
    const stream = await createAudioStream(parsed);
    const primedStream = await primeAudioStream(stream);

    return new Response(primedStream, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "audio/mpeg",
      },
    });
  } catch (error) {
    console.error("tts synthesis failed", error);
    return errorResponse(502, "TTS_UPSTREAM_ERROR", "failed to synthesize audio");
  }
}
