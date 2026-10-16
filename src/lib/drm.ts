/**
 * `Sec-MS-GEC` token generation for Microsoft Edge TTS.
 *
 * Ported from the `drm.py` module shipped with `edge-tts` 7.3.1. In 2026
 * Microsoft moved the token to a versioned format: the `Sec-MS-GEC` parameter
 * is now `<16 hex>-<64 hex>` (a CS64 digest and a SHA-256-derived digest joined
 * by a dash) and must be paired with a `Sec-MS-GEC-Version` of
 * `2-<chromium version>`. A v1 token (a bare 64-hex SHA-256) sent alongside a
 * `1-` version is rejected with HTTP 403 on both synthesis hosts.
 *
 * The digests are deliberately non-standard: the SHA-256 variant uses patched
 * round constants and a midstate shortcut, so Web Crypto's `subtle.digest`
 * cannot be substituted for it. `test/drm.spec.ts` pins this port against
 * vectors produced by the reference Python implementation.
 *
 * All arithmetic is 32-bit modular. Multiplications use `Math.imul` because a
 * plain `*` would lose the low bits once the product exceeds 2^53.
 */

export const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";

const WIN_EPOCH_SECONDS = 11644473600;
/** 100-nanosecond ticks, i.e. `1e9` nanoseconds per second divided by 100. */
const SECONDS_TO_TICKS = 1e7;
/** Token buckets advance every 5 minutes. */
const TOKEN_BUCKET_SECONDS = 300;

const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19,
];

const SHA256_STATE = [
  0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a, 0x6c006f49, 0x04bd35ab,
  0xfeb0a7e4, 0x03effbd2,
];

const SHA256_SCHEDULE = [
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

const SHA256_ADJUSTMENT = 0xc9dc06a7;
const SHA256_SIGMA0_ADJUSTMENT = 0x059c0b80;
const SHA256_SIGMA1_ADJUSTMENT = 0x000b92c0;

/** Round 14 uses a patched constant when resuming inside the first block. */
const SHA256_BLOCK_CONSTANTS = [
  ...SHA256_ROUND_CONSTANTS.slice(0, 14),
  SHA256_ADJUSTMENT,
  ...SHA256_ROUND_CONSTANTS.slice(15),
];

/** `[coefficient, offset]` pairs driving the CS64 digest. */
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

function rotr32(value: number, shift: number): number {
  return ((value >>> shift) | (value << (32 - shift))) >>> 0;
}

function rol16(value: number): number {
  const v = value >>> 0;
  return ((v << 16) | (v >>> 16)) >>> 0;
}

/** SHA-256 small sigma zero. */
function ssig0(value: number): number {
  const v = value >>> 0;
  return ((v >>> 7) ^ (v << 25) ^ (v >>> 18) ^ (v << 14) ^ (v >>> 3)) >>> 0;
}

/** SHA-256 small sigma one. */
function ssig1(value: number): number {
  const v = value >>> 0;
  return ((v >>> 17) ^ (v << 15) ^ (v >>> 19) ^ (v << 13) ^ (v >>> 10)) >>> 0;
}

/** SHA-256 big sigma zero, i.e. ROTR(2) ^ ROTR(13) ^ ROTR(22). */
function bsig0(value: number): number {
  const v = value >>> 0;
  return (rotr32(v, 2) ^ rotr32(v, 13) ^ rotr32(v, 22)) >>> 0;
}

/** SHA-256 big sigma one, i.e. ROTR(6) ^ ROTR(11) ^ ROTR(25). */
function bsig1(value: number): number {
  const v = value >>> 0;
  return (rotr32(v, 6) ^ rotr32(v, 11) ^ rotr32(v, 25)) >>> 0;
}

function ch(x: number, y: number, z: number): number {
  return (z ^ (x & (y ^ z))) >>> 0;
}

function maj(x: number, y: number, z: number): number {
  return ((x & y) | (z & (x | y))) >>> 0;
}

/**
 * Runs SHA-256 rounds over `words`.
 *
 * `firstRound` lets the caller resume mid-block: the reference implementation
 * folds the first 14 rounds into precomputed constants, so a block starting at
 * round 14 uses `SHA256_BLOCK_CONSTANTS` and takes a different path.
 *
 * Note each round feeds the *updated* registers into the next round's sigma and
 * choice terms. The reference expresses this by rotating the register roles
 * while rotating the values, which the unrolled form below spells out.
 */
function sha256Rounds(
  state: number[],
  words: number[],
  firstRound = 0
): number[] {
  let [a, b, c, d, e, f, g, h] = state as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const constants =
    firstRound === 14 ? SHA256_BLOCK_CONSTANTS : SHA256_ROUND_CONSTANTS;
  const aligned = Math.min(64, Math.floor((firstRound + 7) / 8) * 8);

  for (let index = firstRound; index < aligned; index += 1) {
    const t1 =
      (h + bsig1(e) + ch(e, f, g) + constants[index] + words[index]) >>> 0;
    const t2 = (bsig0(a) + maj(a, b, c)) >>> 0;
    const nextA = (t1 + t2) >>> 0;
    const nextE = (d + t1) >>> 0;

    h = g;
    g = f;
    f = e;
    e = nextE;
    d = c;
    c = b;
    b = a;
    a = nextA;
  }

  for (let index = aligned; index < 64; index += 8) {
    let t1 = (h + bsig1(e) + ch(e, f, g) + constants[index] + words[index]) >>> 0;
    d = (d + t1) >>> 0;
    h = (t1 + bsig0(a) + maj(a, b, c)) >>> 0;

    t1 = (g + bsig1(d) + ch(d, e, f) + constants[index + 1] + words[index + 1]) >>> 0;
    c = (c + t1) >>> 0;
    g = (t1 + bsig0(h) + maj(h, a, b)) >>> 0;

    t1 = (f + bsig1(c) + ch(c, d, e) + constants[index + 2] + words[index + 2]) >>> 0;
    b = (b + t1) >>> 0;
    f = (t1 + bsig0(g) + maj(g, h, a)) >>> 0;

    t1 = (e + bsig1(b) + ch(b, c, d) + constants[index + 3] + words[index + 3]) >>> 0;
    a = (a + t1) >>> 0;
    e = (t1 + bsig0(f) + maj(f, g, h)) >>> 0;

    t1 = (d + bsig1(a) + ch(a, b, c) + constants[index + 4] + words[index + 4]) >>> 0;
    h = (h + t1) >>> 0;
    d = (t1 + bsig0(e) + maj(e, f, g)) >>> 0;

    t1 = (c + bsig1(h) + ch(h, a, b) + constants[index + 5] + words[index + 5]) >>> 0;
    g = (g + t1) >>> 0;
    c = (t1 + bsig0(d) + maj(d, e, f)) >>> 0;

    t1 = (b + bsig1(g) + ch(g, h, a) + constants[index + 6] + words[index + 6]) >>> 0;
    f = (f + t1) >>> 0;
    b = (t1 + bsig0(c) + maj(c, d, e)) >>> 0;

    t1 = (a + bsig1(f) + ch(f, g, h) + constants[index + 7] + words[index + 7]) >>> 0;
    e = (e + t1) >>> 0;
    a = (t1 + bsig0(b) + maj(b, c, d)) >>> 0;
  }

  return [a, b, c, d, e, f, g, h];
}

function expandSchedule(words: number[], firstWord = 16): void {
  for (let index = firstWord; index < 64; index += 1) {
    const value =
      (ssig1(words[index - 2]) +
        words[index - 7] +
        ssig0(words[index - 15]) +
        words[index - 16]) >>>
      0;
    words.push(value);
  }
}

/**
 * Builds the SHA-256 midstate for the first seven bytes of the token salt.
 *
 * The reference folds the first 14 rounds into `SHA256_STATE` and a precomputed
 * schedule, so only the tail of the salt is hashed conventionally.
 */
function sha256Init(salt: Uint8Array): number[] {
  const words: number[] = new Array(14).fill(0);
  words.push(((salt[0] << 16) | (salt[1] << 8) | salt[2]) >>> 0);
  words.push(
    ((salt[3] << 24) | (salt[4] << 16) | (salt[5] << 8) | salt[6]) >>> 0
  );

  for (let index = 16; index < 30; index += 1) {
    let value = SHA256_SCHEDULE[index - 16];
    value +=
      index === 16
        ? ssig1(words[index - 2]) ^ SHA256_SIGMA1_ADJUSTMENT
        : ssig1(words[index - 2]);

    if (index >= 21) {
      value += words[index - 7];
    }

    if (index >= 29) {
      value += ssig0(words[index - 15]) ^ SHA256_SIGMA0_ADJUSTMENT;
    }

    words.push(value >>> 0);
  }

  words.push(
    (ssig1(words[28]) +
      words[23] +
      ssig0(words[15]) +
      words[14] +
      SHA256_ADJUSTMENT -
      SHA256_ROUND_CONSTANTS[14]) >>>
      0
  );

  expandSchedule(words, 31);

  const working = sha256Rounds(SHA256_STATE, words, 14);

  return working.map((value, index) => (value + SHA256_INITIAL[index]) >>> 0);
}

function sha256Digest(data: Uint8Array): Uint8Array {
  if (data.length < 7) {
    throw new Error("token salt must contain at least seven bytes");
  }

  const length = 57 + data.length;
  const body = data.subarray(7);
  const zeroPadding = (((55 - length) % 64) + 64) % 64;

  const padded = new Uint8Array(body.length + 1 + zeroPadding + 8);
  padded.set(body, 0);
  padded[body.length] = 0x80;

  const bitLength = length * 8;
  const paddedView = new DataView(padded.buffer);
  paddedView.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  paddedView.setUint32(padded.length - 4, bitLength >>> 0);

  let state = sha256Init(data.subarray(0, 7));

  for (let offset = 0; offset < padded.length; offset += 64) {
    const words: number[] = [];

    for (let index = 0; index < 16; index += 1) {
      const at = offset + index * 4;
      words.push(
        ((padded[at] << 24) |
          (padded[at + 1] << 16) |
          (padded[at + 2] << 8) |
          padded[at + 3]) >>>
          0
      );
    }

    expandSchedule(words);

    const working = sha256Rounds(state, words);
    state = working.map((value, index) => (value + state[index]) >>> 0);
  }

  const digest = new Uint8Array(32);
  const digestView = new DataView(digest.buffer);

  state.forEach((value, index) => digestView.setUint32(index * 4, value));

  return digest;
}

/** Splits bytes into little-endian 32-bit words, zero-padded to an even count. */
function wordsLe4Even(bytes: Uint8Array): number[] {
  const paddedLength = Math.ceil(bytes.length / 4) * 4;

  if (paddedLength === 0) {
    return [];
  }

  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);

  const words: number[] = [];

  for (let index = 0; index < paddedLength; index += 4) {
    words.push(
      (padded[index] |
        (padded[index + 1] << 8) |
        (padded[index + 2] << 16) |
        (padded[index + 3] << 24)) >>>
        0
    );
  }

  if (words.length % 2 === 1) {
    words.push(0);
  }

  return words;
}

function cs64Digest(
  data: Uint8Array,
  digest: Uint8Array
): [number, number] {
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
    ([coefficient], index) =>
      Math.imul(coefficient, factors[index % 2]) >>> 0
  );
  const offsets = CS64_COEFFICIENTS.map(([, offset]) => offset);

  // The salted input is the token with one leading zero byte.
  const salted = new Uint8Array(data.length + 1);
  salted.set(data, 1);

  wordsLe4Even(salted).forEach((word, index) => {
    let term = Math.imul(word, index % 2 === 0 ? keyA : keyB);
    let offset = Math.imul(
      rol16(word),
      index % 2 === 0 ? 0xef0569fb : 0xc31713db
    );

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

    let t = rol16((offsets[index] + x) >>> 0);
    let q = Math.imul(t, 0x76f50f34) >>> 0;
    swapAcc = (swapAcc + ((Math.imul(rol16(q), 0xc3efea97) + q) >>> 0)) >>> 0;

    t = rol16((offsets[index + 1] + y) >>> 0);
    q = Math.imul(t, 0x1881ce3c) >>> 0;
    swapLast = (Math.imul(rol16(q), 0x35bd1ec9) + q) >>> 0;
    swapAcc = (swapAcc + swapLast) >>> 0;

    state = (Math.imul(state, keyA) + x) >>> 0;
    state = Math.imul(rol16(state), 0xcf98b111) >>> 0;
    state = Math.imul(rol16(state), 0x87085b9f) >>> 0;
    state = Math.imul(rol16(state), 0x12ceb96d) >>> 0;
    state = Math.imul(rol16(state), 0x257e1d83) >>> 0;
    acc = (acc + state) >>> 0;

    t = (Math.imul(state, keyB) + y) >>> 0;
    t = Math.imul(rol16(t), 0xa27416f5) >>> 0;
    t = Math.imul(rol16(t), 0xd38396ff) >>> 0;
    state =
      Math.imul(rol16(Math.imul(rol16(t), 0x7c932b89) >>> 0), 0xbfa49f69) >>> 0;
    acc = (acc + state) >>> 0;
  }

  return [(swapLast ^ state) >>> 0, (swapAcc ^ acc) >>> 0];
}

/** Renders a 32-bit word as its little-endian bytes in uppercase hex. */
function leHex(value: number): string {
  const v = value >>> 0;

  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function tokenHash(data: Uint8Array): { cs64: string; sha256: string } {
  const digest = sha256Digest(data);
  const [high, low] = cs64Digest(data, digest);

  return {
    cs64: `${leHex(high)}${leHex(low)}`,
    sha256: Array.from(digest, (byte) =>
      byte.toString(16).padStart(2, "0")
    )
      .join("")
      .toUpperCase(),
  };
}

/**
 * Builds the salted payload the token digests are computed over.
 *
 * The tick count is a float64 large enough (about 6.4e16) that the reference
 * relies on float rounding, so this keeps the same operation order rather than
 * switching to integer arithmetic.
 */
function buildTokenSalt(unixSeconds: number): Uint8Array {
  let ticks = unixSeconds + WIN_EPOCH_SECONDS;
  ticks -= ticks % TOKEN_BUCKET_SECONDS;
  ticks *= SECONDS_TO_TICKS;

  return new TextEncoder().encode(
    `${ticks.toFixed(0)}${TRUSTED_CLIENT_TOKEN}`
  );
}

/** Returns the value for the `Sec-MS-GEC` query parameter. */
export function generateSecMsGecV2(
  unixSeconds: number = Date.now() / 1000
): string {
  const { cs64, sha256 } = tokenHash(buildTokenSalt(unixSeconds));

  return `${cs64}-${sha256}`;
}
