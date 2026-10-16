/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";

const { getVoicesMock, createAudioStreamMock } = vi.hoisted(() => ({
  getVoicesMock: vi.fn(),
  createAudioStreamMock: vi.fn(),
}));

vi.mock("../src/lib/tts", () => ({
  DEFAULT_VOICE: "en-US-AvaMultilingualNeural",
  getVoices: getVoicesMock,
  createAudioStream: createAudioStreamMock,
}));

import worker from "../src/index";
import { handleTtsHealth } from "../src/handlers/tts-health";

const IncomingRequest = Request;

async function dispatch(request: Request) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, {} as Env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const sampleVoices = [
  {
    Name: "Microsoft Server Speech Text to Speech Voice (zh-CN, XiaoxiaoNeural)",
    ShortName: "zh-CN-XiaoxiaoNeural",
    Gender: "Female",
    Locale: "zh-CN",
    SuggestedCodec: "audio-24khz-48kbitrate-mono-mp3",
    FriendlyName: "Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)",
    Status: "GA",
    VoiceTag: {
      ContentCategories: ["General"],
      VoicePersonalities: ["Friendly"],
    },
  },
];

describe("worker routes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    getVoicesMock.mockResolvedValue(sampleVoices);
    createAudioStreamMock.mockResolvedValue(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
      })
    );
  });

  it("returns health status", async () => {
    const response = await dispatch(
      new IncomingRequest("https://example.com/health")
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("returns voices", async () => {
    const response = await dispatch(
      new IncomingRequest("https://example.com/voices")
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ voices: sampleVoices });
  });

  it("returns upstream error when voices fetch fails", async () => {
    const upstreamError = new Error("upstream failed");
    getVoicesMock.mockRejectedValueOnce(upstreamError);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await dispatch(
      new IncomingRequest("https://example.com/voices")
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: {
        code: "TTS_UPSTREAM_ERROR",
        message: "failed to fetch voices",
      },
    });
    expect(consoleError).toHaveBeenCalledWith(
      "voice list fetch failed",
      upstreamError
    );
  });

  it("returns audio stream for valid tts requests", async () => {
    const response = await dispatch(
      new IncomingRequest("https://example.com/tts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: " hello world ",
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(createAudioStreamMock).toHaveBeenCalledWith({
      text: "hello world",
      voice: undefined,
    });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3])
    );
  });

  it("forwards explicit voice for tts requests", async () => {
    const response = await dispatch(
      new IncomingRequest("https://example.com/tts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: "hello world",
          voice: "en-US-JennyNeural",
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(createAudioStreamMock).toHaveBeenCalledWith({
      text: "hello world",
      voice: "en-US-JennyNeural",
    });
  });

  it("accepts application json with charset parameters", async () => {
    const response = await dispatch(
      new IncomingRequest("https://example.com/tts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          text: "hello world",
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(createAudioStreamMock).toHaveBeenCalledWith({
      text: "hello world",
      voice: undefined,
    });
  });

  it("rejects non-json tts requests", async () => {
    const response = await dispatch(
      new IncomingRequest("https://example.com/tts", {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
        },
        body: "hello world",
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "INVALID_CONTENT_TYPE",
        message: "content-type must be application/json",
      },
    });
  });

  it("rejects json-like but invalid content types", async () => {
    const response = await dispatch(
      new IncomingRequest("https://example.com/tts", {
        method: "POST",
        headers: {
          "Content-Type": "application/jsonp",
        },
        body: JSON.stringify({
          text: "hello world",
        }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "INVALID_CONTENT_TYPE",
        message: "content-type must be application/json",
      },
    });
  });

  it("rejects invalid json bodies with a stable error message", async () => {
    const response = await dispatch(
      new IncomingRequest("https://example.com/tts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: "{",
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "INVALID_REQUEST",
        message: "request body must be valid json",
      },
    });
  });

  it("rejects tts requests with missing text", async () => {
    const response = await dispatch(
      new IncomingRequest("https://example.com/tts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "INVALID_REQUEST",
        message: "text is required",
      },
    });
  });

  it("rejects tts requests with non-string voice", async () => {
    const response = await dispatch(
      new IncomingRequest("https://example.com/tts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: "hello world",
          voice: 123,
        }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "INVALID_REQUEST",
        message: "voice must be a string",
      },
    });
  });

  it("rejects tts requests with an empty voice string", async () => {
    const response = await dispatch(
      new IncomingRequest("https://example.com/tts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: "hello world",
          voice: "",
        }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "INVALID_REQUEST",
        message: "voice must be a non-empty string",
      },
    });
  });

  it("returns upstream error when tts synthesis fails before streaming starts", async () => {
    const upstreamError = new Error("WebSocket upgrade failed with status 403");
    createAudioStreamMock.mockRejectedValueOnce(upstreamError);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await dispatch(
      new IncomingRequest("https://example.com/tts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: "hello world",
        }),
      })
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: {
        code: "TTS_UPSTREAM_ERROR",
        message: "failed to synthesize audio",
      },
    });
    expect(consoleError).toHaveBeenCalledWith(
      "tts synthesis failed",
      upstreamError
    );
  });

  it("returns upstream error when the first audio chunk read fails", async () => {
    const streamError = new Error("stream failed");
    createAudioStreamMock.mockResolvedValueOnce(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(streamError);
        },
      })
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await dispatch(
      new IncomingRequest("https://example.com/tts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: "hello world",
        }),
      })
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: {
        code: "TTS_UPSTREAM_ERROR",
        message: "failed to synthesize audio",
      },
    });
    expect(consoleError).toHaveBeenCalledWith(
      "tts synthesis failed",
      streamError
    );
  });

  it("answers CORS preflight requests", async () => {
    const response = await dispatch(
      new IncomingRequest("https://example.com/tts", {
        method: "OPTIONS",
        headers: {
          Origin: "https://app.example.com",
          "Access-Control-Request-Method": "POST",
        },
      })
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("returns method not allowed for POST /health", async () => {
    const response = await dispatch(
      new IncomingRequest("https://example.com/health", {
        method: "POST",
      })
    );

    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({
      error: {
        code: "METHOD_NOT_ALLOWED",
        message: "method not allowed",
      },
    });
  });

  it("returns not found for unknown routes", async () => {
    const response = await dispatch(
      new IncomingRequest("https://example.com/missing")
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "route not found",
      },
    });
  });
});

function audioStream(...chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

describe("tts health probe", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    createAudioStreamMock.mockImplementation(async () =>
      audioStream(new Uint8Array([1, 2, 3]))
    );
  });

  it("synthesizes a short phrase with each default voice", async () => {
    const response = await dispatch(
      new IncomingRequest("https://example.com/health/tts")
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(createAudioStreamMock).toHaveBeenCalledTimes(2);
    expect(createAudioStreamMock).toHaveBeenCalledWith({
      text: "health check",
      voice: "en-US-AvaMultilingualNeural",
    });
    expect(createAudioStreamMock).toHaveBeenCalledWith({
      text: "健康检查",
      voice: "zh-CN-XiaoxiaoNeural",
    });
    expect(await response.json()).toEqual({
      ok: true,
      checks: [
        {
          voice: "en-US-AvaMultilingualNeural",
          ok: true,
          status: 200,
          contentType: "audio/mpeg",
          bytes: 3,
          durationMs: expect.any(Number),
        },
        {
          voice: "zh-CN-XiaoxiaoNeural",
          ok: true,
          status: 200,
          contentType: "audio/mpeg",
          bytes: 3,
          durationMs: expect.any(Number),
        },
      ],
    });
  });

  it("returns 503 when a voice fails to synthesize", async () => {
    const upstreamError = new Error("WebSocket upgrade failed with status 403");
    createAudioStreamMock.mockImplementation(async ({ voice }) => {
      if (voice === "zh-CN-XiaoxiaoNeural") {
        throw upstreamError;
      }

      return audioStream(new Uint8Array([1, 2, 3]));
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await dispatch(
      new IncomingRequest("https://example.com/health/tts")
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      checks: [
        {
          voice: "en-US-AvaMultilingualNeural",
          ok: true,
          status: 200,
          contentType: "audio/mpeg",
          bytes: 3,
          durationMs: expect.any(Number),
        },
        {
          voice: "zh-CN-XiaoxiaoNeural",
          ok: false,
          status: 502,
          contentType: "application/json; charset=utf-8",
          bytes: expect.any(Number),
          durationMs: expect.any(Number),
        },
      ],
    });
    expect(consoleError).toHaveBeenCalledWith(
      "tts synthesis failed",
      upstreamError
    );
    expect(consoleError).toHaveBeenCalledWith(
      "tts health probe failed",
      expect.objectContaining({ voice: "zh-CN-XiaoxiaoNeural", status: 502 })
    );
  });

  it("fails a probe whose audio body is empty", async () => {
    createAudioStreamMock.mockImplementation(async () => audioStream());
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await dispatch(
      new IncomingRequest("https://example.com/health/tts")
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      checks: [
        { ok: false, status: 200, contentType: "audio/mpeg", bytes: 0 },
        { ok: false, status: 200, contentType: "audio/mpeg", bytes: 0 },
      ],
    });
  });

  it("probes a single voice passed in the query string", async () => {
    const response = await dispatch(
      new IncomingRequest(
        "https://example.com/health/tts?voice=ja-JP-NanamiNeural"
      )
    );

    expect(response.status).toBe(200);
    expect(createAudioStreamMock).toHaveBeenCalledTimes(1);
    expect(createAudioStreamMock).toHaveBeenCalledWith({
      text: "health check",
      voice: "ja-JP-NanamiNeural",
    });
    expect(await response.json()).toMatchObject({
      ok: true,
      checks: [{ voice: "ja-JP-NanamiNeural", ok: true }],
    });
  });

  it("fails a probe that does not finish in time", async () => {
    createAudioStreamMock.mockImplementation(
      async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
          },
        })
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await handleTtsHealth(
      new IncomingRequest("https://example.com/health/tts"),
      20
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      checks: [
        { ok: false, status: 200, error: "timed out after 20 ms" },
        { ok: false, status: 200, error: "timed out after 20 ms" },
      ],
    });
  });

  it("returns method not allowed for POST /health/tts", async () => {
    const response = await dispatch(
      new IncomingRequest("https://example.com/health/tts", {
        method: "POST",
      })
    );

    expect(response.status).toBe(405);
    expect(createAudioStreamMock).not.toHaveBeenCalled();
  });
});
