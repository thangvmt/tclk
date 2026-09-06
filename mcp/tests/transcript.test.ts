// SPDX-License-Identifier: Apache-2.0
//
// Folding a room transcript: a full happy path, a refund path, and the fail-closed
// behaviour that matters most — hostile and out-of-order lines get a verdict, not a
// throw, and money-state only advances on frames that verify.

import { describe, expect, it } from "vitest";

import {
  dealRoom, decodeFrame, encodeFrame, generateHashLock, makeAccept, makeHeartbeat, makeOffer,
  type TranscriptRecord,
} from "@flop-labs/tclk";

import { canonicalMessage, signerFromSeed } from "../src/signing.js";
import { createHandlers } from "../src/tools.js";
import {
  HASH_OFFER, NOW, PAYEE_DID, PAYEE_SEED, PAYER_DID, PAYER_SEED, hexToBytes,
} from "./fixtures.js";

const h = createHandlers({ env: {} });
const payer = signerFromSeed(hexToBytes(PAYER_SEED));
const payee = signerFromSeed(hexToBytes(PAYEE_SEED));

function records(lines: string[], timestampMs: number | number[]): TranscriptRecord[] {
  // seq is per room on the venue, so number it per room here too. A single global counter
  // made the derived room start at 2 and tripped the derived-room anchor on the happy path.
  const nextSeq = new Map<string, number>();
  return lines.map((line, index) => {
    let from = PAYER_DID;
    let room = "mb-p-tclk-deadbeefdeadbeef";
    try {
      const frame = decodeFrame(line);
      from = frame.from;
      if (frame.type === "offer" || frame.type === "accept") room = "tclk-offers";
      else room = dealRoom(frame.contract);
    } catch {
      // Signed non-frame room traffic still gets a fold verdict.
    }
    const signer = from === PAYEE_DID ? payee : payer;
    const nonce = String(1000 + index);
    const seq = (nextSeq.get(room) ?? 0) + 1;
    nextSeq.set(room, seq);
    return {
      room,
      seq,
      timestampMs: typeof timestampMs === "number" ? timestampMs : timestampMs[index]!,
      sender: signer.did,
      nonce,
      signature: signer.sign(canonicalMessage(room, Number(nonce), line)),
      line,
    };
  });
}

function openDeal(offerFields = HASH_OFFER) {
  const offer = h.tclk_make_offer(offerFields);
  const accept = h.tclk_accept_offer({ offer: offer.line, from: PAYEE_DID });
  return { offer, accept };
}

describe("happy path", () => {
  it("folds offer → accept → lock → reveal → receipt to claimed", () => {
    const { offer, accept } = openDeal();
    const lock = h.tclk_make_lock({
      from: PAYER_DID,
      contract: accept.contract,
      rail: "flop-htlc",
      ref: "escrow-42",
    });
    const reveal = h.tclk_make_reveal({
      from: PAYEE_DID,
      contract: accept.contract,
      ref: "escrow-42",
      secret: accept.secret,
    });
    const receipt = h.tclk_make_receipt({
      from: PAYER_DID,
      contract: accept.contract,
      outcome: "claimed",
      rail: "flop-htlc",
      ref: "escrow-42",
    });

    const result = h.tclk_apply_transcript({
      records: records([offer.line, accept.line, lock.line, reveal.line, receipt.line], NOW),
    });

    expect(result.steps.map((s) => s.ok)).toEqual([true, true, true, true, true]);
    expect(result.status).toBe("claimed");
    expect(result.contract).toBe(accept.contract);
    expect(result.parties).toEqual({
      payer: PAYER_DID,
      payee: PAYEE_DID,
      payerKey: null,
      payeeKey: null,
    });
    expect(result.rail).toBe("flop-htlc");
    expect(result.railRef).toBe("escrow-42");
    // A whole transcript carries the standing ts/seq trust-boundary note and nothing else.
    // Numbering seq globally across the board and the deal room used to start the derived
    // room at 2 and trip the completeness anchor here, silently, because nothing asserted.
    expect(result.warnings.some((w: string) => w.includes("no authenticated seq 1"))).toBe(false);
    expect(result.warnings.some((w: string) => w.includes("gap detected"))).toBe(false);

    // The revealed secret is in the transcript the caller already holds; this server
    // reports only that one exists.
    expect(result.secretRevealed).toBe(true);
    expect(JSON.stringify(result)).not.toContain(accept.secret.slice(2));
  });
});

describe("refund path", () => {
  it("folds offer → accept → lock → refund to refunded once the window is open", () => {
    const { offer, accept } = openDeal();
    const lock = h.tclk_make_lock({
      from: PAYER_DID,
      contract: accept.contract,
      rail: "flop-htlc",
      ref: "escrow-43",
    });
    const refund = h.tclk_make_refund({
      from: PAYER_DID,
      contract: accept.contract,
      ref: "escrow-43",
      reason: "payee never revealed",
    });

    const open = h.tclk_apply_transcript({
      records: records(
        [offer.line, accept.line, lock.line, refund.line],
        [NOW - 1, NOW, NOW + 1, HASH_OFFER.refundAfterMs],
      ),
    });
    expect(open.steps.map((s) => s.ok)).toEqual([true, true, true, true]);
    expect(open.status).toBe("refunded");
    expect(open.secretRevealed).toBe(false);

    // With only the refund record moved one millisecond before the boundary, the lock
    // remains valid but the refund is refused.
    const early = h.tclk_apply_transcript({
      records: records(
        [offer.line, accept.line, lock.line, refund.line],
        [NOW - 1, NOW, NOW + 1, HASH_OFFER.refundAfterMs - 1],
      ),
    });
    expect(early.status).toBe("locked");
    expect(early.steps[3]).toMatchObject({ ok: false, reason: "refund window not open yet" });
  });
});

describe("fail-closed folding", () => {
  it("gives garbage and out-of-turn frames a verdict, never a throw", () => {
    const { offer, accept } = openDeal();
    const stolenReveal = h.tclk_make_reveal({
      from: PAYER_DID,
      contract: accept.contract,
      ref: "escrow-44",
      secret: accept.secret,
    });

    const result = h.tclk_apply_transcript({
      records: records(
        [
          "gm everyone",
          offer.line,
          "tclk1 {\"type\":\"lock\"}",
          accept.line,
          stolenReveal.line,
        ],
        NOW,
      ),
    });

    expect(result.steps[0]).toMatchObject({ ok: false });
    expect(result.steps[1]).toMatchObject({ ok: true, type: "offer" });
    expect(result.steps[2]).toMatchObject({ ok: false });
    expect(result.steps[3]).toMatchObject({ ok: true, type: "accept" });
    // Never locked, so the reveal cannot land — and the payer is not the payee anyway.
    expect(result.steps[4]).toMatchObject({ ok: false, reason: "reveal in status accepted" });
    expect(result.status).toBe("accepted");
    expect(result.secretRevealed).toBe(false);
  });

  it("refuses a transcript with no offer to open from", () => {
    expect(() => h.tclk_apply_transcript({
      records: records(["gm", "still not a frame"], NOW),
    })).toThrow(/no authenticated offer frame/);
  });
  it("propagates the derived-room completeness warning through tclk_apply_transcript", () => {
    const lock = generateHashLock();
    const offer = makeOffer(HASH_OFFER);
    const accept = makeAccept(offer, { from: PAYEE_DID, statement: lock.hash });
    const room = dealRoom(accept.contract);

    const lines = [
      encodeFrame(offer),
      encodeFrame(accept),
      encodeFrame(makeHeartbeat({ from: PAYER_DID, contract: accept.contract })),
      encodeFrame({ type: "lock", from: PAYER_DID, contract: accept.contract, rail: "flop-htlc", ref: "escrow-42" }),
      encodeFrame({ type: "reveal", from: PAYEE_DID, contract: accept.contract, secret: lock.preimage }),
      encodeFrame({ type: "receipt", from: PAYER_DID, contract: accept.contract, outcome: "claimed" }),
    ];
    const whole = records(lines, NOW);
    expect(whole.filter((r) => r.room === room).map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    const wholeWarnings = h.tclk_apply_transcript({ records: whole }).warnings;
    expect(wholeWarnings.some((w: string) => w.includes("no authenticated seq 1"))).toBe(false);

    // Drop the deal room's opening row. What remains is 2,3,4: contiguous, every signature
    // intact, and the fold still claims. An agent folding through this server has to be told.
    const censored = whole.filter((r) => !(r.room === room && r.seq === 1));
    const result = h.tclk_apply_transcript({ records: censored });
    expect(result.status).toBe("claimed");
    expect(result.steps.every((step) => step.ok)).toBe(true);
    expect(result.warnings.some((w: string) => w.includes("gap detected"))).toBe(false);
    expect(result.warnings.some((w: string) => w.includes("no authenticated seq 1"))).toBe(true);
  });

});
