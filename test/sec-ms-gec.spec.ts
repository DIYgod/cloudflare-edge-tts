import { describe, expect, it } from "vitest";

import { generateSecMsGec, hashSecMsGecPayload } from "../src/lib/sec-ms-gec";

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";

// Expected values come from edge-tts 7.3.x `generate_sec_ms_gec_v2`
// (rany2/edge-tts ba61d944), whose tokens the service accepts.
describe("generateSecMsGec", () => {
  it.each([
    [
      0,
      "52BC7A17B50DFEC9-28C4394775C8751CD2F6859C030C06DB1489ACAB3B3A7651831FC26895177ED6",
    ],
    [
      1700000000,
      "2CD23A2CA0B2595A-F3C846C370E05F9CC83ACC5F995C5F5D87A4D0F14CE8936A0F902E64099E38A2",
    ],
    [
      1760600000.5,
      "382DA39AE9C7234A-D592F521358E457AC9556722046D878B004105AEE12B81167D37FD4778D35E78",
    ],
    [
      1792134000,
      "CF0B4395B2CD4BA5-EC6B89FFC22DF1DBD6A58EF3BC4A5F778F76C002BD63C080F0A4104A5FAEC52B",
    ],
    [
      2000000000,
      "2D62557F1142BC5D-FD9C30C68FF194A5EE6B45FEFC5E2BA1D1239F88A90569AB55CFFFAA7799F40E",
    ],
  ])("matches the reference token at %s", (unixSeconds, expected) => {
    expect(generateSecMsGec(TRUSTED_CLIENT_TOKEN, unixSeconds)).toBe(expected);
  });

  it("keeps the token for a five-minute window", () => {
    const token = generateSecMsGec(TRUSTED_CLIENT_TOKEN, 1792134000);

    expect(generateSecMsGec(TRUSTED_CLIENT_TOKEN, 1792134299.9)).toBe(token);
    expect(generateSecMsGec(TRUSTED_CLIENT_TOKEN, 1792134300)).not.toBe(token);
  });
});

describe("hashSecMsGecPayload", () => {
  it.each([
    [
      "1234567",
      "CF8264F204E37578-4B4B1B27BCB09F84AE904B387373DA006A64E1B4EFCC1BAF1D6F289D44E6DAC8",
    ],
    [
      "12345678",
      "FF68734F9C22A4D6-F7CC197E8281C6E3B1AE9BC5214DFF71C9E86469BCFAA2DABD23507CDA13FC63",
    ],
    [
      "x".repeat(55),
      "996577B3641023D6-05A53DDF994DCE366C6ED80548479F12ECF745F579F815913817D28CBE6E34FE",
    ],
    [
      "y".repeat(56),
      "2A0B6457A67319DA-78F668C7076B12D2D0E2F88FB482EB7C287923EDFA932EA8BBB67A8B60FF8D97",
    ],
    [
      "z".repeat(63),
      "BC12C68945A0583B-E9C75AD567FB678DE4365DC1C924FA5B518A0B02A21D388B33B9D62F74C9092B",
    ],
    [
      "w".repeat(64),
      "C0D297350783A55E-A0E1576CC8374BF56BB38AD0275E85DD93A4C1969200DFAE859C7D14C74E7E5F",
    ],
    [
      "v".repeat(130),
      "E287CC0106D6B526-C059029B109D097EABB34794ABBB179A6D37BC429515FE7111EE64BF933970C7",
    ],
  ])("matches the reference hash for payload %#", (payload, expected) => {
    expect(hashSecMsGecPayload(payload)).toBe(expected);
  });

  it("rejects payloads shorter than seven bytes", () => {
    expect(() => hashSecMsGecPayload("123456")).toThrow(
      "Sec-MS-GEC payload must contain at least seven bytes"
    );
  });
});
