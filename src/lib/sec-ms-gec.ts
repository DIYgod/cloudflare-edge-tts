// Sec-MS-GEC v2 token for the Edge read-aloud service, sent together with
// `Sec-MS-GEC-Version: 2-<edge version>`. Since 2026-10-10 the synthesis
// WebSocket answers v1 tokens (a plain SHA-256 hex digest) with 403.
//
// Ported from edge-tts `generate_sec_ms_gec_v2` (rany2/edge-tts ba61d944,
// src/edge_tts/drm.py). The token is "<CS64 hex>-<SHA-256 hex>" over the
// payload `${windowsFileTimeTicks}${trustedClientToken}`:
// - the SHA-256 runs over a fixed 57-byte prefix followed by the payload. The
//   first 56 prefix bytes only survive as the state after round 13 and their
//   share of message words 16-29; the last prefix byte (0x2E) shares word 14
//   with the payload and is folded into the round 14 constant and the sigma
//   adjustments.
// - the CS64 checksum runs over the payload, keyed by that digest.

const WIN_EPOCH_SECONDS = 11644473600;
const TOKEN_WINDOW_SECONDS = 300;

// FIPS 180-4 initial hash value.
const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19,
];
// Working variables after rounds 0-13 of the first block.
const SHA256_PREFIX_STATE = [
  0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a, 0x6c006f49, 0x04bd35ab,
  0xfeb0a7e4, 0x03effbd2,
];
// Contribution of message words 0-13 to the schedule words 16-29.
const SHA256_PREFIX_SCHEDULE = [
  0xeb24bf9e, 0x1558691f, 0xa0c09ee2, 0x0cfa32ba, 0xa622ee8c, 0xd1dd9491,
  0xc0dd25a0, 0xf9e70ab6, 0xf0c31573, 0x7058ce4e, 0x7188e606, 0x00e5ab33,
  0xd258b060, 0x72766564,
];
const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
// Round 14 constant plus the prefix byte 0x2E at the top of word 14.
const SHA256_ROUND_14_ADJUSTMENT = 0xc9dc06a7;
const SHA256_PREFIX_BLOCK_CONSTANTS = SHA256_ROUND_CONSTANTS.map(
  (constant, index) => (index === 14 ? SHA256_ROUND_14_ADJUSTMENT : constant)
);
// sigma0(0x2E000000) and sigma1(0x2E000000).
const SHA256_SIGMA0_ADJUSTMENT = 0x059c0b80;
const SHA256_SIGMA1_ADJUSTMENT = 0x000b92c0;

const CS64_COEFFICIENTS: ReadonlyArray<readonly [number, number]> = [
  [0xe82e91b1, 0xb32700d0],
  [0x44de24c6, 0x88dff51d],
  [0x3beb65bc, 0x29514038],
  [0xc89c5933, 0xb328cbdf],
  [0x8d1ec211, 0xd405b4d5],
  [0x314ef5d5, 0x26e55f3c],
  [0xe92491b1, 0x607801c6],
  [0xf0a5b9d5, 0x82b2c1fb],
  [0x06064cf3, 0xfa51a3da],
  [0xda79fa60, 0x207cc464],
  [0xbed20560, 0x3c3c74f3],
  [0x89f9c9f8, 0xd2d14b61],
  [0x35fa38c6, 0xbb04a2c1],
  [0xcb49e3c6, 0xc5626167],
];
const CS64_FACTOR = 0x82893933;
const CS64_ADJUSTMENT0 = 0xf2f90b1a;
const CS64_ADJUSTMENT1 = 0x0b1a0000;

function rotr(value: number, bits: number) {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

function rol16(value: number) {
  return ((value << 16) | (value >>> 16)) >>> 0;
}

function sigma0(value: number) {
  return (rotr(value, 7) ^ rotr(value, 18) ^ (value >>> 3)) >>> 0;
}

function sigma1(value: number) {
  return (rotr(value, 17) ^ rotr(value, 19) ^ (value >>> 10)) >>> 0;
}

function expandSchedule(words: number[], firstWord = 16) {
  for (let index = firstWord; index < 64; index += 1) {
    words[index] =
      (sigma1(words[index - 2]) +
        words[index - 7] +
        sigma0(words[index - 15]) +
        words[index - 16]) >>>
      0;
  }
}

function compress(
  state: readonly number[],
  words: readonly number[],
  firstRound = 0
) {
  const constants =
    firstRound === 14 ? SHA256_PREFIX_BLOCK_CONSTANTS : SHA256_ROUND_CONSTANTS;
  let [a, b, c, d, e, f, g, h] = state;

  for (let index = firstRound; index < 64; index += 1) {
    const t1 =
      (h +
        (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) +
        (g ^ (e & (f ^ g))) +
        constants[index] +
        words[index]) >>>
      0;
    const t2 =
      ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) | (c & (a | b)))) >>>
      0;
    h = g;
    g = f;
    f = e;
    e = (d + t1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) >>> 0;
  }

  return [a, b, c, d, e, f, g, h];
}

// State after the first block: the prefix plus the first seven payload bytes.
function prefixBlockState(payload: Uint8Array) {
  const words = new Array<number>(14).fill(0);
  words.push((payload[0] << 16) | (payload[1] << 8) | payload[2]);
  words.push(
    ((payload[3] << 24) |
      (payload[4] << 16) |
      (payload[5] << 8) |
      payload[6]) >>>
      0
  );

  for (let index = 16; index < 30; index += 1) {
    let value =
      SHA256_PREFIX_SCHEDULE[index - 16] +
      (index === 16
        ? (sigma1(words[14]) ^ SHA256_SIGMA1_ADJUSTMENT) >>> 0
        : sigma1(words[index - 2]));
    if (index >= 21) {
      value += words[index - 7];
    }
    if (index === 29) {
      value += (sigma0(words[14]) ^ SHA256_SIGMA0_ADJUSTMENT) >>> 0;
    }
    words.push(value >>> 0);
  }

  words.push(
    (sigma1(words[28]) +
      words[23] +
      sigma0(words[15]) +
      words[14] +
      SHA256_ROUND_14_ADJUSTMENT -
      SHA256_ROUND_CONSTANTS[14]) >>>
      0
  );
  expandSchedule(words, 31);

  const working = compress(SHA256_PREFIX_STATE, words, 14);
  return SHA256_INITIAL.map((value, index) => (value + working[index]) >>> 0);
}

function sha256Digest(payload: Uint8Array) {
  if (payload.length < 7) {
    throw new Error("Sec-MS-GEC payload must contain at least seven bytes");
  }

  const messageLength = 57 + payload.length;
  const zeroPadding = (((55 - messageLength) % 64) + 64) % 64;
  const tail = new Uint8Array(payload.length - 7 + 1 + zeroPadding + 8);
  tail.set(payload.subarray(7));
  tail[payload.length - 7] = 0x80;

  const tailView = new DataView(tail.buffer);
  const bitLength = messageLength * 8;
  tailView.setUint32(tail.length - 8, Math.floor(bitLength / 2 ** 32));
  tailView.setUint32(tail.length - 4, bitLength >>> 0);

  let state = prefixBlockState(payload);
  for (let offset = 0; offset < tail.length; offset += 64) {
    const words: number[] = [];
    for (let index = 0; index < 16; index += 1) {
      words.push(tailView.getUint32(offset + index * 4));
    }
    expandSchedule(words);

    const working = compress(state, words);
    state = state.map((value, index) => (value + working[index]) >>> 0);
  }

  const digest = new Uint8Array(32);
  const digestView = new DataView(digest.buffer);
  state.forEach((value, index) => digestView.setUint32(index * 4, value));
  return digest;
}

// Little-endian 32-bit words of a zero byte followed by the payload,
// zero-padded to an even word count.
function cs64Words(payload: Uint8Array) {
  const byteLength = Math.ceil((payload.length + 1) / 8) * 8;
  const bytes = new Uint8Array(byteLength);
  bytes.set(payload, 1);

  const view = new DataView(bytes.buffer);
  const words: number[] = [];
  for (let offset = 0; offset < byteLength; offset += 4) {
    words.push(view.getUint32(offset, true));
  }
  return words;
}

function cs64Digest(payload: Uint8Array, digest: Uint8Array) {
  const digestView = new DataView(
    digest.buffer,
    digest.byteOffset,
    digest.byteLength
  );
  const keyA = (digestView.getUint32(0, true) | 1) >>> 0;
  const keyB = (digestView.getUint32(4, true) | 1) >>> 0;
  const factors = [
    Math.imul(keyA, CS64_FACTOR) >>> 0,
    Math.imul(keyB, CS64_FACTOR) >>> 0,
  ];

  const terms = CS64_COEFFICIENTS.map(
    ([coefficient], index) => Math.imul(coefficient, factors[index % 2]) >>> 0
  );
  const offsets = CS64_COEFFICIENTS.map(([, offset]) => offset);
  cs64Words(payload).forEach((word, index) => {
    const even = index % 2 === 0;
    let term = Math.imul(word, even ? keyA : keyB);
    let offset = Math.imul(rol16(word), even ? 0xef0569fb : 0xc31713db);
    if (index === 0) {
      term += Math.imul(CS64_ADJUSTMENT0, factors[0]);
      offset += CS64_ADJUSTMENT1;
    }
    terms.push(term >>> 0);
    offsets.push(offset >>> 0);
  });

  let swapAcc = 0;
  let swapLast = 0;
  let state = 0;
  let acc = 0;
  for (let index = 0; index < terms.length; index += 2) {
    const x = terms[index];
    const y = terms[index + 1];

    let q = Math.imul(rol16((offsets[index] + x) >>> 0), 0x76f50f34) >>> 0;
    swapAcc = (swapAcc + Math.imul(rol16(q), 0xc3efea97) + q) >>> 0;
    q = Math.imul(rol16((offsets[index + 1] + y) >>> 0), 0x1881ce3c) >>> 0;
    swapLast = (Math.imul(rol16(q), 0x35bd1ec9) + q) >>> 0;
    swapAcc = (swapAcc + swapLast) >>> 0;

    state = (Math.imul(state, keyA) + x) >>> 0;
    state = Math.imul(rol16(state), 0xcf98b111) >>> 0;
    state = Math.imul(rol16(state), 0x87085b9f) >>> 0;
    state = Math.imul(rol16(state), 0x12ceb96d) >>> 0;
    state = Math.imul(rol16(state), 0x257e1d83) >>> 0;
    acc = (acc + state) >>> 0;

    let t = (Math.imul(state, keyB) + y) >>> 0;
    t = Math.imul(rol16(t), 0xa27416f5) >>> 0;
    t = Math.imul(rol16(t), 0xd38396ff) >>> 0;
    t = Math.imul(rol16(t), 0x7c932b89) >>> 0;
    state = Math.imul(rol16(t), 0xbfa49f69) >>> 0;
    acc = (acc + state) >>> 0;
  }

  return [(swapLast ^ state) >>> 0, (swapAcc ^ acc) >>> 0];
}

function toHex(bytes: Uint8Array) {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

export function hashSecMsGecPayload(payload: string) {
  const bytes = new TextEncoder().encode(payload);
  const digest = sha256Digest(bytes);
  const checksum = new Uint8Array(8);
  const checksumView = new DataView(checksum.buffer);
  cs64Digest(bytes, digest).forEach((word, index) =>
    checksumView.setUint32(index * 4, word, true)
  );

  return `${toHex(checksum)}-${toHex(digest)}`;
}

export function generateSecMsGec(
  trustedClientToken: string,
  unixSeconds = Date.now() / 1000
) {
  let ticks = unixSeconds + WIN_EPOCH_SECONDS;
  ticks -= ticks % TOKEN_WINDOW_SECONDS;
  ticks *= 1e7;
  return hashSecMsGecPayload(`${ticks.toFixed(0)}${trustedClientToken}`);
}
