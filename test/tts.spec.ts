import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_VOICE,
  createAudioStream,
  getVoices,
  type TtsRuntime,
} from "../src/lib/tts";

function createDigestBytes() {
  return Uint8Array.from(
    { length: 32 },
    (_, index) => (index + 1) & 0xff
  ).buffer;
}

function createRuntime(fetchImpl: TtsRuntime["fetch"]): TtsRuntime {
  return {
    fetch: fetchImpl,
    crypto: {
      subtle: {
        digest: vi.fn().mockResolvedValue(createDigestBytes()),
      },
      getRandomValues: vi.fn((array: Uint8Array) => {
        for (let index = 0; index < array.length; index += 1) {
          array[index] = (index + 17) & 0xff;
        }
        return array;
      }),
      randomUUID: vi.fn(
        () => "12345678-90ab-4def-8123-4567890abcde"
      ),
    } as unknown as Crypto,
  };
}

class FakeWebSocket {
  accepted = false;
  sent: Array<string | ArrayBufferLike | Blob | ArrayBufferView> = [];
  private listeners = new Map<string, Set<(event: unknown) => void>>();

  accept() {
    this.accepted = true;
  }

  addEventListener(type: string, listener: (event: unknown) => void) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }

    this.listeners.get(type)?.add(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    this.sent.push(data);
  }

  close() {
    this.emit("close", {});
  }

  emitMessage(data: unknown) {
    this.emit("message", { data });
  }

  emitError(error: unknown) {
    this.emit("error", error);
  }

  private emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function createAudioFrame(bytes: number[]) {
  const headerText = "Path:audio\r\nContent-Type:audio/mpeg\r\n";
  const headerBytes = new TextEncoder().encode(headerText);
  const frame = new Uint8Array(2 + headerBytes.length + bytes.length);

  frame[0] = (headerBytes.length >> 8) & 0xff;
  frame[1] = headerBytes.length & 0xff;
  frame.set(headerBytes, 2);
  frame.set(bytes, 2 + headerBytes.length);

  return frame.buffer;
}

async function readAll(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    chunks.push(value);
  }

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return merged;
}

describe("createAudioStream", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("opens a websocket upgrade request and streams audio chunks for the default voice", async () => {
    const socket = new FakeWebSocket();
    const fetchMock = vi.fn().mockResolvedValue({
      status: 101,
      headers: new Headers({
        Upgrade: "websocket",
      }),
      webSocket: socket,
    });
    const runtime = createRuntime(fetchMock);

    const stream = await createAudioStream({ text: "hello world" }, runtime);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain(
      "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1"
    );
    expect(String(url)).toContain("TrustedClientToken=");
    expect(String(url)).toContain("ConnectionId=");
    // A v1 token paired with a `1-` version is what made the handshake 403.
    const params = new URL(String(url)).searchParams;
    expect(params.get("Sec-MS-GEC-Version")).toMatch(/^2-\d+\./);
    expect(params.get("Sec-MS-GEC")).toMatch(/^[0-9A-F]{16}-[0-9A-F]{64}$/);
    expect(init?.headers).toMatchObject({
      Upgrade: "websocket",
      "Sec-WebSocket-Version": "13",
    });
    expect((init?.headers as Record<string, string>).Origin).toBeUndefined();
    expect(String((init?.headers as Record<string, string>).Cookie)).toContain(
      "muid="
    );
    expect(socket.accepted).toBe(true);
    expect(socket.sent).toHaveLength(2);
    expect(String(socket.sent[0])).toContain("Path:speech.config");
    expect(String(socket.sent[1])).toContain("Path:ssml");
    expect(String(socket.sent[1])).toContain(
      "Microsoft Server Speech Text to Speech Voice (en-US, AvaMultilingualNeural)"
    );
    expect(String(socket.sent[1])).toContain("hello world");

    queueMicrotask(() => {
      socket.emitMessage(createAudioFrame([1, 2, 3]));
      socket.close();
    });

    const bytes = await readAll(stream);
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });

  it("normalizes short voice names before sending ssml", async () => {
    const socket = new FakeWebSocket();
    const fetchMock = vi.fn().mockResolvedValue({
      status: 101,
      headers: new Headers({
        Upgrade: "websocket",
      }),
      webSocket: socket,
    });
    const runtime = createRuntime(fetchMock);

    const stream = await createAudioStream(
      {
        text: "hello world",
        voice: "en-US-EmmaMultilingualNeural",
      },
      runtime
    );

    queueMicrotask(() => {
      socket.emitMessage(createAudioFrame([9]));
      socket.close();
    });

    await readAll(stream);

    expect(String(socket.sent[1])).toContain(
      "Microsoft Server Speech Text to Speech Voice (en-US, EmmaMultilingualNeural)"
    );
  });

  it("maps provider voice aliases to a supported short voice", async () => {
    const socket = new FakeWebSocket();
    const fetchMock = vi.fn().mockResolvedValue({
      status: 101,
      headers: new Headers({
        Upgrade: "websocket",
      }),
      webSocket: socket,
    });
    const runtime = createRuntime(fetchMock);

    const stream = await createAudioStream(
      {
        text: "hello world",
        voice: "zh-CN-Xiaoxiao:DragonHDFlashLatestNeural",
      },
      runtime
    );

    queueMicrotask(() => {
      socket.emitMessage(createAudioFrame([7]));
      socket.close();
    });

    await readAll(stream);

    expect(String(socket.sent[1])).toContain(
      "Microsoft Server Speech Text to Speech Voice (zh-CN, XiaoxiaoNeural)"
    );
  });

  it("throws when the websocket upgrade is rejected", async () => {
    const runtime = createRuntime(
      vi.fn().mockResolvedValue({
        status: 403,
        headers: new Headers(),
      })
    );

    await expect(
      createAudioStream({ text: "hello world" }, runtime)
    ).rejects.toThrow("WebSocket upgrade failed with status 403");
  });
});

describe("getVoices", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches the vendor voice list over http", async () => {
    const vendorVoices = [
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
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue(vendorVoices),
      headers: new Headers(),
    });
    const runtime = createRuntime(fetchMock);

    const voices = await getVoices(runtime);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain(
      "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list"
    );
    expect(String(url)).toContain("trustedclienttoken=");
    const params = new URL(String(url)).searchParams;
    expect(params.get("Sec-MS-GEC-Version")).toMatch(/^2-\d+\./);
    expect(params.get("Sec-MS-GEC")).toMatch(/^[0-9A-F]{16}-[0-9A-F]{64}$/);
    expect(init?.headers).toMatchObject({
      Accept: "*/*",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
    });
    expect(voices).toBe(vendorVoices);
  });
});
