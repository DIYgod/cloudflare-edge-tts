import { json } from "../lib/http";
import { handleTts } from "./tts";

type Probe = {
  voice: string;
  text: string;
};

type ProbeResult = {
  voice: string;
  ok: boolean;
  status: number;
  contentType: string;
  bytes: number;
  durationMs: number;
  error?: string;
};

const DEFAULT_PROBES: Probe[] = [
  { voice: "en-US-AvaMultilingualNeural", text: "health check" },
  { voice: "zh-CN-XiaoxiaoNeural", text: "健康检查" },
];

const PROBE_TIMEOUT_MS = 15_000;

async function runProbe(
  url: URL,
  { voice, text }: Probe,
  timeoutMs: number
): Promise<ProbeResult> {
  const startedAt = Date.now();
  const result: ProbeResult = {
    voice,
    ok: false,
    status: 0,
    contentType: "",
    bytes: 0,
    durationMs: 0,
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${timeoutMs} ms`)),
      timeoutMs
    );
  });

  try {
    // Run the same handler as POST /tts so the probe covers request
    // parsing, the upstream WebSocket and the audio stream.
    const response = await Promise.race([
      handleTts(
        new Request(new URL("/tts", url), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, voice }),
        })
      ),
      timeout,
    ]);
    result.status = response.status;
    result.contentType = response.headers.get("content-type") ?? "";
    result.bytes = (
      await Promise.race([response.arrayBuffer(), timeout])
    ).byteLength;
    result.ok =
      result.status === 200 &&
      result.contentType.startsWith("audio/mpeg") &&
      result.bytes > 0;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
  }

  result.durationMs = Date.now() - startedAt;

  if (!result.ok) {
    console.error("tts health probe failed", result);
  }

  return result;
}

export async function handleTtsHealth(
  request: Request,
  timeoutMs = PROBE_TIMEOUT_MS
) {
  const url = new URL(request.url);
  const voice = url.searchParams.get("voice")?.trim();
  const probes = voice ? [{ voice, text: "health check" }] : DEFAULT_PROBES;
  const checks = await Promise.all(
    probes.map((probe) => runProbe(url, probe, timeoutMs))
  );
  const ok = checks.every((check) => check.ok);

  return json(
    { ok, checks },
    {
      status: ok ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    }
  );
}
