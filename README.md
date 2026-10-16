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

## Setup

Install dependencies:

```bash
npm install
```

Generate Worker environment types:

```bash
npm run cf-typegen
```

## Development

Remote runtime development with Cloudflare:

```bash
npm run dev
```

Local runtime development:

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

Deploy the Worker:

```bash
npm run deploy
```

## Implementation Note

This Worker does not rely on `edge-tts-universal` at runtime. It performs the voice-list fetch and WebSocket synthesis handshake directly inside the Worker runtime.

### `Sec-MS-GEC` token version

Microsoft validates the `Sec-MS-GEC` query parameter against the prefix of `Sec-MS-GEC-Version`, and rejects a mismatched pair with HTTP 403 on both synthesis hosts:

| `Sec-MS-GEC-Version` | required `Sec-MS-GEC` value |
| --- | --- |
| `1-<chromium version>` | bare 64-hex SHA-256 |
| `2-<chromium version>` | `<16 hex>-<64 hex>` (CS64 digest joined to a SHA-256 digest) |

This Worker sends the `2-` pairing. `src/lib/drm.ts` builds the token and `test/drm.spec.ts` pins it against vectors from the `edge-tts` reference implementation: the digests are deliberately non-standard (patched SHA-256 round constants plus a CS64 mix), so Web Crypto cannot produce them and any drift breaks synthesis.

## Notes

Observed remote validation result on 2026-04-10 with `wrangler 4.81.1`:

- `npx wrangler whoami` succeeded
- The authenticated Cloudflare account context used for the run was `1f1d1678a2413a54c944b3081bab5c84`
- `npm run dev` started `wrangler dev --remote`, uploaded a remote preview, and reported `Ready on http://localhost:8787`
- `curl -i --max-time 20 http://127.0.0.1:8787/health` returned `200 OK`
- The `/voices` smoke test returned `200`, produced `/tmp/cloudflare-edge-tts-voices.headers`, and wrote a JSON payload containing `ShortName` entries to `/tmp/cloudflare-edge-tts-voices.json`
- The `/tts` smoke test returned `200`, produced `/tmp/cloudflare-edge-tts-tts.headers`, and wrote an `audio/mpeg` body to `/tmp/cloudflare-edge-tts-tts.body`

This means the current Worker-native implementation was verified successfully against both `wrangler dev --local` and `wrangler dev --remote` in this environment.

Observed on 2026-10-16 with `wrangler 4.81.1`:

- `POST /tts` began failing with `WebSocket upgrade failed with status 403` because the Worker sent a v1 token paired with a `1-` version
- Both hosts were probed directly: the legacy host requires the `2-` pairing, and `api.msedgeservices.com` (which takes the token as `Ocp-Apim-Subscription-Key` rather than `TrustedClientToken`) accepts either pairing
- After switching to the `2-` pairing, `GET /health`, `GET /voices`, and `POST /tts` were re-verified end to end against the live service in the real runtime: `POST /tts` returns `200`, `audio/mpeg`, and a body that `file` reports as `MPEG ADTS, layer III`

One caveat about local development: `wrangler dev --local` was observed losing the upstream audio frames for some inputs, which surfaces as `502 failed to synthesize audio` whose underlying error is `no audio received`. The identical requests return `200` in the real runtime, so prefer `wrangler dev --remote` when checking synthesis locally.
