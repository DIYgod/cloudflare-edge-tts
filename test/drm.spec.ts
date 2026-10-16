import { describe, expect, it } from "vitest";

import { generateSecMsGecV2 } from "../src/lib/drm";

/**
 * Vectors produced by the reference implementation:
 *
 *   python -c "from edge_tts.drm import generate_sec_ms_gec_v2 as g; print(g(1700000000))"
 *
 * with `edge-tts` 7.3.1. They pin this port byte-for-byte, which matters because
 * the digests are non-standard (patched SHA-256 round constants plus a CS64
 * mix); Microsoft rejects any drift with HTTP 403.
 */
const REFERENCE_VECTORS: Array<[unixSeconds: number, expected: string]> = [
  [
    1700000000,
    "2CD23A2CA0B2595A-F3C846C370E05F9CC83ACC5F995C5F5D87A4D0F14CE8936A0F902E64099E38A2",
  ],
  [
    1712345678,
    "5EEFCDB6BB925924-EF25132E29C4B6608F2627793735A304B8F58EFFEA7FF29EED6CFF3AECDE34B6",
  ],
  [
    1750000000,
    "B029A7426816F097-4579D112DC47FC3BF432B499C0A282F427C659474AF9BF5FA33CE2C003F9E9C2",
  ],
  [
    1760000001,
    "6D50DDDB91812C33-DD68EFB01898B0750C9797D51A5FF93471DFDAE6888A1039D532CBDCCE54545D",
  ],
  [
    1799999999,
    "8DD724B1AF1AEBDA-7EAB32704E1EBDC4C7D8109CC130E2B31826441D7C07CA6E8118FBCE8902837E",
  ],
  [
    1800000000,
    "99E54519B490BE5C-E162DB0977FBDCB9B86DD8148BF1BCDC3C0303176CE39852A42B415935C20654",
  ],
  [
    1850000000,
    "D05F6D995025295B-30ACF4EAB5A85267041CF99584A861030A881795AE8F90162C3CD23008F20AD1",
  ],
  [
    1900000000,
    "35CB2860F259268E-7C6AC7AAFAF9ECFDEF5C38802D91759C088D45E6E8BDBC2EC1C78C22D51F1DF6",
  ],
  [
    2000000000,
    "2D62557F1142BC5D-FD9C30C68FF194A5EE6B45FEFC5E2BA1D1239F88A90569AB55CFFFAA7799F40E",
  ],
];

describe("generateSecMsGecV2", () => {
  it.each(REFERENCE_VECTORS)(
    "matches the reference implementation for unixSeconds=%i",
    (unixSeconds, expected) => {
      expect(generateSecMsGecV2(unixSeconds)).toBe(expected);
    }
  );

  it("emits a 16-hex CS64 digest and a 64-hex SHA-256 digest joined by a dash", () => {
    const token = generateSecMsGecV2(1750000000);

    expect(token).toMatch(/^[0-9A-F]{16}-[0-9A-F]{64}$/);
  });

  it("keeps the token stable inside a five minute bucket and rotates after it", () => {
    const bucketStart = 1750000800;
    const insideBucket = generateSecMsGecV2(bucketStart + 299);

    expect(generateSecMsGecV2(bucketStart)).toBe(insideBucket);
    expect(generateSecMsGecV2(bucketStart + 300)).not.toBe(insideBucket);
  });

  it("changes the token when the claims change", () => {
    expect(generateSecMsGecV2(1700000000)).not.toBe(
      generateSecMsGecV2(1700000300)
    );
  });
});
