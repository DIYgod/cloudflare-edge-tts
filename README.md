# cloudflare-edge-tts

Minimal Cloudflare Worker that exposes Microsoft Edge Text-to-Speech over HTTP using a Worker-native implementation built on `fetch(..., { Upgrade: "websocket" })`.

## Endpoints

### `GET /health`

Returns a lightweight health response:

```json
{
  "ok": true
}
```

### `GET /health/tts`

Runs a real synthesis through the `POST /tts` handler for `en-US-AvaMultilingualNeural` ("health check") and `zh-CN-XiaoxiaoNeural` ("健康检查") and reports each result. It returns `200` when every voice returned `audio/mpeg` with a non-empty body, otherwise `503`. Each probe times out after 15 seconds. Pass `?voice=<ShortName>` to probe a single voice instead.

```json
{
  "ok": true,
  "checks": [
    {
      "voice": "en-US-AvaMultilingualNeural",
      "ok": true,
      "status": 200,
      "contentType": "audio/mpeg",
      "bytes": 11232,
      "durationMs": 605
    }
  ]
}
```

`/health` only shows that the Worker is running, so uptime monitoring should poll `/health/tts`. From 2026-10-10 to 2026-10-16 every synthesis failed while `/health` and `/voices` kept returning `200`.

### `GET /voices`

Returns the available Edge TTS voices:

```json
{
  "voices": [
    {
      "Name": "Microsoft Server Speech Text to Speech Voice (en-US, AvaMultilingualNeural)",
      "ShortName": "en-US-AvaMultilingualNeural"
    }
  ]
}
```

The `voices` payload includes `ShortName` values. This Worker's default voice is `en-US-AvaMultilingualNeural`. Callers may pass any discovered `ShortName`, and the Worker also accepts certain provider-style aliases when they can be mapped to a compatible Edge TTS voice.

### `POST /tts`

Synthesizes speech and streams `audio/mpeg` back to the client.

Request body:

```json
{
  "text": "你好，世界",
  "voice": "en-US-AvaMultilingualNeural"
}
```

`voice` is optional. When omitted, the Worker uses `en-US-AvaMultilingualNeural`.

Validation and error behavior:

- Requires `Content-Type: application/json`
- Requires a non-empty string `text`
- Rejects empty `voice` strings
- Returns `502` when the upstream TTS request fails before the audio response starts, for example before or while priming the first chunk

## Configuration

The Worker is configured in `cloudflare.config.ts` and is built, run locally and deployed with Cloudflare's [`cf` CLI](https://developers.cloudflare.com/cf/), a dev dependency that uses the project's Wrangler as its bundler.

`wrangler.jsonc` stays for the tools that still read it: remote development (`npm run dev`, since `cf dev` has no remote mode), the Vitest Workers pool and `wrangler tail`. Keep its name, account, compatibility date and `workers_dev` setting in sync with `cloudflare.config.ts`.

## Setup

Install dependencies:

```bash
npm install
```

Generate Worker environment types into `.cloudflare/types/index.d.ts` (`npm run typecheck` also regenerates them):

```bash
npm run cf-typegen
```

## Development

Remote runtime development with Cloudflare (`wrangler dev --remote`):

```bash
npm run dev
```

Local runtime development (`cf dev`):

```bash
npm run dev:local
```

## Testing

Run the test suite:

```bash
npm test
```

Run TypeScript checks:

```bash
npm run typecheck
```

## Remote Smoke Test

Real-runtime validation uses `wrangler dev --remote`.

Confirm the authenticated Cloudflare account:

```bash
npx wrangler whoami
```

Start the remote dev server on localhost:

```bash
npm run dev
```

Use the actual URL printed by Wrangler if it differs from `http://127.0.0.1:8787`.

In another terminal, run the smoke test:

```bash
curl -i --max-time 20 http://127.0.0.1:8787/health
curl -sS --max-time 20 \
  -D /tmp/cloudflare-edge-tts-voices.headers \
  http://127.0.0.1:8787/voices \
  --output /tmp/cloudflare-edge-tts-voices.json && \
  awk 'NR==1 { print $2 }' /tmp/cloudflare-edge-tts-voices.headers
curl -sS --max-time 30 \
  -D /tmp/cloudflare-edge-tts-tts.headers \
  -H 'Content-Type: application/json' \
  http://127.0.0.1:8787/tts \
  --data '{"text":"你好，世界"}' \
  --output /tmp/cloudflare-edge-tts-tts.body && \
  awk 'NR==1 { print $2 }' /tmp/cloudflare-edge-tts-tts.headers && \
  file /tmp/cloudflare-edge-tts-tts.body
```

Expected checks:

- `/health` should return `200`
- `/voices` should write headers to `/tmp/cloudflare-edge-tts-voices.headers`, write JSON to `/tmp/cloudflare-edge-tts-voices.json`, and report an HTTP `200` status
- The voices response should contain one or more `ShortName` entries
- `/tts` should write headers to `/tmp/cloudflare-edge-tts-tts.headers`, write the response body to `/tmp/cloudflare-edge-tts-tts.body`, and report the HTTP status
- A successful `/tts` call should be `200` with `audio/mpeg`; a failure should remain inspectable as headers plus a non-audio body, such as a JSON error response

## Deployment

Deploy the Worker with `cf deploy`:

```bash
npm run deploy
```

`cf` authenticates with `CLOUDFLARE_API_TOKEN` and does not reuse a Wrangler login. `cf deploy --dry-run` builds the Worker and lists what it would deploy without uploading anything.

## Implementation Note

This Worker does not rely on `edge-tts-universal` at runtime. It performs the voice-list fetch and WebSocket synthesis handshake directly inside the Worker runtime.

Upstream requests carry a v2 `Sec-MS-GEC` token with `Sec-MS-GEC-Version=2-<Edge version>`, generated in `src/lib/sec-ms-gec.ts` (ported from edge-tts 7.3). Since 2026-10-10 the synthesis WebSocket rejects the old v1 token, a plain SHA-256 digest, with HTTP 403, which reached clients as `502 TTS_UPSTREAM_ERROR` while `/voices` kept working. Upstream failures are logged with `console.error`, so `wrangler tail cloudflare-edge-tts` shows the cause behind a 502 (`cf` cannot stream live logs yet).

## Notes

Observed remote validation result on 2026-04-10 with `wrangler 4.81.1`:

- `npx wrangler whoami` succeeded
- The authenticated Cloudflare account context used for the run was `1f1d1678a2413a54c944b3081bab5c84`
- `npm run dev` started `wrangler dev --remote`, uploaded a remote preview, and reported `Ready on http://localhost:8787`
- `curl -i --max-time 20 http://127.0.0.1:8787/health` returned `200 OK`
- The `/voices` smoke test returned `200`, produced `/tmp/cloudflare-edge-tts-voices.headers`, and wrote a JSON payload containing `ShortName` entries to `/tmp/cloudflare-edge-tts-voices.json`
- The `/tts` smoke test returned `200`, produced `/tmp/cloudflare-edge-tts-tts.headers`, and wrote an `audio/mpeg` body to `/tmp/cloudflare-edge-tts-tts.body`

This means the current Worker-native implementation was verified successfully against both `wrangler dev --local` and `wrangler dev --remote` in this environment.
