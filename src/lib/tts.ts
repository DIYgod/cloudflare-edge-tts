import { TRUSTED_CLIENT_TOKEN, generateSecMsGecV2 } from "./drm";

export const DEFAULT_VOICE = "en-US-AvaMultilingualNeural";

const READALOUD_BASE =
  "speech.platform.bing.com/consumer/speech/synthesize/readaloud";
const VOICE_LIST_URL = `https://${READALOUD_BASE}/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`;
const SYNTHESIS_URL = `https://${READALOUD_BASE}/edge/v1`;
const CHROMIUM_FULL_VERSION = "143.0.3650.75";
const CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.split(".")[0];
/**
 * The `2-` prefix selects the v2 `Sec-MS-GEC` token and must stay in step with
 * `generateSecMsGecV2`. Pairing a v1 token with a `1-` version, as this Worker
 * used to do, is rejected with HTTP 403 — see `./drm`.
 */
const SEC_MS_GEC_VERSION = `2-${CHROMIUM_FULL_VERSION}`;
const AUDIO_FORMAT = "audio-24khz-48kbitrate-mono-mp3";

const BASE_HEADERS = {
  "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`,
  "Accept-Language": "en-US,en;q=0.9",
};

const UPGRADE_HEADERS = {
  ...BASE_HEADERS,
  "Accept-Encoding": "gzip, deflate, br, zstd",
  Pragma: "no-cache",
  "Cache-Control": "no-cache",
  "Sec-WebSocket-Version": "13",
  Upgrade: "websocket",
};

const VOICE_HEADERS = {
  ...BASE_HEADERS,
  Authority: "speech.platform.bing.com",
  "Sec-CH-UA": `" Not;A Brand";v="99", "Microsoft Edge";v="${CHROMIUM_MAJOR_VERSION}", "Chromium";v="${CHROMIUM_MAJOR_VERSION}"`,
  "Sec-CH-UA-Mobile": "?0",
  Accept: "*/*",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Dest": "empty",
};

export type Voice = {
  Name: string;
  ShortName: string;
  Gender: string;
  Locale: string;
  SuggestedCodec: string;
  FriendlyName: string;
  Status: string;
  VoiceTag: {
    ContentCategories: string[];
    VoicePersonalities: string[];
  };
};

export type TtsInput = {
  text: string;
  voice?: string;
};

export type TtsRuntime = {
  fetch: typeof fetch;
  crypto: Crypto;
};

type UpgradeResponse = Response & {
  webSocket?: WebSocket;
};

function defaultRuntime(): TtsRuntime {
  return {
    fetch: (input, init) => fetch(input, init),
    crypto: globalThis.crypto,
  };
}

function normalizeVoiceName(voice: string) {
  const trimmed = voice.trim();
  const providerMatch = /^([a-z]{2,}-[A-Z]{2,})-([^:]+):.+Neural$/.exec(trimmed);
  if (providerMatch) {
    const [, locale, baseName] = providerMatch;
    return normalizeVoiceName(`${locale}-${baseName}Neural`);
  }

  const shortMatch = /^([a-z]{2,})-([A-Z]{2,})-(.+Neural)$/.exec(trimmed);

  if (!shortMatch) {
    return trimmed;
  }

  const [, lang] = shortMatch;
  let [, , region, name] = shortMatch;

  if (name.includes("-")) {
    const [regionSuffix, ...nameParts] = name.split("-");
    region += `-${regionSuffix}`;
    name = nameParts.join("-");
  }

  return `Microsoft Server Speech Text to Speech Voice (${lang}-${region}, ${name})`;
}

function escapeXml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function removeInvalidXmlCharacters(text: string) {
  return text.replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g,
    " "
  );
}

function makeConnectionId(runtime: TtsRuntime) {
  return runtime.crypto.randomUUID().replace(/-/g, "");
}

function makeMuid(runtime: TtsRuntime) {
  const bytes = new Uint8Array(16);
  runtime.crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function buildSynthesisUrl(secMsGec: string, connectionId: string) {
  const url = new URL(SYNTHESIS_URL);
  url.searchParams.set("TrustedClientToken", TRUSTED_CLIENT_TOKEN);
  url.searchParams.set("Sec-MS-GEC", secMsGec);
  url.searchParams.set("Sec-MS-GEC-Version", SEC_MS_GEC_VERSION);
  url.searchParams.set("ConnectionId", connectionId);
  return url.toString();
}

function buildSpeechConfigMessage() {
  return (
    `X-Timestamp:${timestamp()}\r\n` +
    "Content-Type:application/json; charset=utf-8\r\n" +
    "Path:speech.config\r\n\r\n" +
    '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n'
  );
}

function buildSsmlMessage(requestId: string, voice: string, text: string) {
  const ssml =
    "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
    `<voice name='${voice}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>${escapeXml(
      removeInvalidXmlCharacters(text)
    )}</prosody></voice></speak>`;

  return (
    `X-RequestId:${requestId}\r\n` +
    "Content-Type:application/ssml+xml\r\n" +
    `X-Timestamp:${timestamp()}Z\r\n` +
    "Path:ssml\r\n\r\n" +
    ssml
  );
}

function timestamp() {
  return new Date().toISOString().replace(/[-:.]/g, "").slice(0, -1);
}

function parseTextHeaders(message: string) {
  const separator = message.indexOf("\r\n\r\n");
  const headerText =
    separator >= 0 ? message.slice(0, separator) : message;
  const headers: Record<string, string> = {};

  for (const line of headerText.split("\r\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex <= 0) {
      continue;
    }

    const key = line.slice(0, colonIndex);
    const value = line.slice(colonIndex + 1).trim();
    headers[key] = value;
  }

  return headers;
}

function parseBinaryAudioFrame(data: Uint8Array) {
  if (data.length < 2) {
    throw new Error("binary websocket frame missing header length");
  }

  const headerLength = (data[0] << 8) | data[1];
  if (data.length < 2 + headerLength) {
    throw new Error("binary websocket frame truncated");
  }

  const headerText = new TextDecoder().decode(
    data.slice(2, 2 + headerLength)
  );
  const headers: Record<string, string> = {};

  for (const line of headerText.split("\r\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex <= 0) {
      continue;
    }

    const key = line.slice(0, colonIndex);
    const value = line.slice(colonIndex + 1).trim();
    headers[key] = value;
  }

  return {
    headers,
    body: data.slice(2 + headerLength),
  };
}

function toUint8Array(data: unknown): Promise<Uint8Array> | Uint8Array | null {
  if (data instanceof Uint8Array) {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return data.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  }

  return null;
}

function toError(error: unknown) {
  if (error instanceof Error) {
    return error;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  ) {
    return new Error((error as { message: string }).message);
  }

  return new Error(String(error));
}

function createReadableAudioStream(
  socket: WebSocket,
  text: string,
  voice: string,
  requestId: string
) {
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let audioReceived = false;
  let settled = false;

  const cleanup = () => {
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("close", onClose);
    socket.removeEventListener("error", onError);
  };

  const finishWithError = (error: unknown) => {
    if (settled) {
      return;
    }

    settled = true;
    cleanup();
    controllerRef?.error(toError(error));
  };

  const finish = () => {
    if (settled) {
      return;
    }

    settled = true;
    cleanup();
    controllerRef?.close();
  };

  const onMessage = (event: Event) => {
    if (settled) {
      return;
    }

    const data = (event as MessageEvent).data;

    if (typeof data === "string") {
      const headers = parseTextHeaders(data);
      const path = headers.Path;
      if (path === "turn.end") {
        try {
          socket.close();
        } catch {
          finish();
        }
        return;
      }

      if (
        path === "response" ||
        path === "turn.start" ||
        path === "audio.metadata"
      ) {
        return;
      }

      finishWithError(new Error(`unexpected websocket text path: ${path}`));
      return;
    }

    const maybeBinary = toUint8Array(data);
    if (!maybeBinary) {
      finishWithError(new Error("unsupported websocket message type"));
      return;
    }

    const handleBinary = (binary: Uint8Array) => {
      if (settled) {
        return;
      }

      const { headers, body } = parseBinaryAudioFrame(binary);
      if (headers.Path !== "audio") {
        throw new Error(`unexpected websocket binary path: ${headers.Path}`);
      }

      if (headers["Content-Type"] !== "audio/mpeg") {
        if (body.length === 0) {
          return;
        }

        throw new Error(
          `unexpected websocket binary content type: ${headers["Content-Type"]}`
        );
      }

      audioReceived = true;
      controllerRef?.enqueue(body);
    };

    if (maybeBinary instanceof Promise) {
      maybeBinary.then(handleBinary).catch((error) => {
        finishWithError(error);
      });
      return;
    }

    try {
      handleBinary(maybeBinary);
    } catch (error) {
      finishWithError(error);
    }
  };

  const onClose = () => {
    if (!audioReceived) {
      finishWithError(new Error("no audio received"));
      return;
    }

    finish();
  };

  const onError = (event: Event) => {
    finishWithError(event);
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      socket.addEventListener("message", onMessage);
      socket.addEventListener("close", onClose);
      socket.addEventListener("error", onError);
      socket.accept();
      socket.send(buildSpeechConfigMessage());
      socket.send(buildSsmlMessage(requestId, voice, text));
    },
    cancel(reason) {
      cleanup();
      settled = true;
      try {
        socket.close(1000, typeof reason === "string" ? reason : "cancelled");
      } catch {
        // ignore close failures during cancellation
      }
    },
  });
}

export async function createAudioStream(
  { text, voice }: TtsInput,
  runtime: TtsRuntime = defaultRuntime()
): Promise<ReadableStream<Uint8Array>> {
  const secMsGec = generateSecMsGecV2();
  const connectionId = makeConnectionId(runtime);
  const websocketUrl = buildSynthesisUrl(secMsGec, connectionId);
  const response = (await runtime.fetch(websocketUrl, {
    headers: {
      ...UPGRADE_HEADERS,
      Cookie: `muid=${makeMuid(runtime)};`,
    },
  })) as UpgradeResponse;

  if (response.status !== 101 || !response.webSocket) {
    throw new Error(`WebSocket upgrade failed with status ${response.status}`);
  }

  return createReadableAudioStream(
    response.webSocket,
    text,
    normalizeVoiceName(voice ?? DEFAULT_VOICE),
    makeConnectionId(runtime)
  );
}

export async function getVoices(
  runtime: TtsRuntime = defaultRuntime()
): Promise<Voice[]> {
  const secMsGec = generateSecMsGecV2();
  const url = `${VOICE_LIST_URL}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;
  let response: Response;

  try {
    response = await runtime.fetch(url, {
      headers: VOICE_HEADERS,
    });
  } catch (error) {
    throw error;
  }

  if (!response.ok) {
    throw new Error(`Voice list request failed with status ${response.status}`);
  }

  return (await response.json()) as Voice[];
}
