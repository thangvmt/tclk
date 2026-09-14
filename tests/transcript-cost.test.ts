// SPDX-License-Identifier: Apache-2.0

// `foldTranscript` runs three passes over the same records: the per-room gap
// analysis, the deadline-frame probe, and the fold itself. Each pass used to call
// `verifyTranscriptRecord` again, so every record paid for three Ed25519
// verifications. Ed25519 dominates the cost of a large retained export, which made
// the warning feature roughly triple the price of a fold even for lines that do not
// decode as TCLK frames.
//
// This file pins the structural contract — one verification per record — instead of
// timing a fold, because a timing assertion is fragile on shared CI. `ed25519` is a
// frozen object, so `vi.spyOn` cannot wrap `verify`; the module is mocked and the
// real implementation is called through a counter.

import { base58, base64urlnopad } from "@scure/base";
import { describe, expect, it, vi } from "vitest";

const counter = vi.hoisted(() => ({ verifications: 0 }));

vi.mock("@noble/curves/ed25519.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@noble/curves/ed25519.js")>();
  return {
    ...actual,
    ed25519: {
      ...actual.ed25519,
      verify(...args: Parameters<typeof actual.ed25519.verify>) {
        counter.verifications += 1;
        return actual.ed25519.verify(...args);
      },
    },
  };
});

const { ed25519 } = await import("@noble/curves/ed25519.js");
const {
  dealRoom,
  encodeFrame,
  foldTranscript,
  generateHashLock,
  makeAccept,
  makeOffer,
} = await import("../src/index.js");
type TranscriptRecord = Awaited<
  typeof import("../src/index.js")
> extends never ? never : Parameters<typeof foldTranscript>[0][number];

const NOW = 1_735_000_000_000;
const BOARD = "tclk-offers";

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)!.map((part) => Number.parseInt(part, 16)));
}

function identity(seedHex: string) {
  const seed = bytes(seedHex);
  const publicKey = ed25519.getPublicKey(seed);
  const tagged = Uint8Array.from([0xed, 0x01, ...publicKey]);
  return {
    did: `did:key:z${base58.encode(tagged)}`,
    sign(canonical: string) {
      return base64urlnopad.encode(ed25519.sign(new TextEncoder().encode(canonical), seed));
    },
  };
}

const payer = identity("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
const payee = identity("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb");

function record(
  room: string,
  seq: number,
  timestampMs: number,
  signer: ReturnType<typeof identity>,
  line: string,
): TranscriptRecord {
  const nonce = String(10_000 + seq);
  return {
    room,
    seq,
    timestampMs,
    sender: signer.did,
    nonce,
    signature: signer.sign(`${room}|${nonce}|${line}`),
    line,
  };
}

function claimedDeal(): TranscriptRecord[] {
  const lock = generateHashLock();
  const offer = makeOffer({
    from: payer.did,
    role: "payer",
    amount: "1000",
    asset: "USDC",
    lock: "hash",
    rails: ["flop-htlc"],
    claimByMs: NOW + 3_600_000,
    refundAfterMs: NOW + 7_200_000,
    expiresMs: NOW + 60_000,
    nonce: "0011223344556677",
  });
  const accept = makeAccept(offer, {
    from: payee.did,
    statement: lock.hash,
    nonce: "8899aabbccddeeff",
  });
  return [
    record(BOARD, 1, NOW - 1, payer, encodeFrame(offer)),
    record(BOARD, 2, NOW, payee, encodeFrame(accept)),
    record(
      dealRoom(accept.contract),
      1,
      NOW + 1,
      payer,
      encodeFrame({
        type: "lock" as const,
        from: payer.did,
        contract: accept.contract,
        rail: "flop-htlc",
        ref: "escrow-42",
      }),
    ),
    record(
      dealRoom(accept.contract),
      2,
      NOW + 2,
      payee,
      encodeFrame({
        type: "reveal" as const,
        from: payee.did,
        contract: accept.contract,
        secret: lock.preimage,
      }),
    ),
  ];
}

describe("transcript fold cost", () => {
  it("verifies each record's signature exactly once", () => {
    const rows = claimedDeal();

    counter.verifications = 0;
    const folded = foldTranscript(rows);

    expect(folded.state?.status).toBe("claimed");
    expect(folded.steps.map((step) => step.ok)).toEqual([true, true, true, true]);
    expect(counter.verifications).toBe(rows.length);
  });

  // @stupeterwilliams-ui counted this case on #115 and it is the sharp one: when every record
  // fails verification, each pass still verifies before it can skip, and the hasDeadlineFrame
  // probe's `some` returns false for an unverified record rather than short-circuiting. So the
  // unpatched fold walks the whole array three times and pays full Ed25519 cost with zero decode
  // work to show for it. That is the corpus foldTranscript exists to handle, so it is the one
  // worth pinning.
  it("verifies once per record even when every record fails verification", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      room: BOARD,
      seq: i + 1,
      timestampMs: NOW + i,
      sender: payer.did,
      nonce: String(10_000 + i),
      signature: "A".repeat(86),
      line: `not a frame ${i}`,
    }));

    counter.verifications = 0;
    const folded = foldTranscript(rows);

    expect(folded.steps.every((step) => !step.ok)).toBe(true);
    expect(counter.verifications).toBe(rows.length);
  });

  it("does not re-verify a record whose line is not a TCLK frame", () => {
    const rows = [
      ...claimedDeal(),
      record(BOARD, 3, NOW + 3, payer, "not a frame at all"),
    ];

    counter.verifications = 0;
    foldTranscript(rows);

    expect(counter.verifications).toBe(rows.length);
  });
});
