// SPDX-License-Identifier: Apache-2.0
//
// The CLI is the evidence contract a reader actually sees. A warning that prints while the
// process still exits 0 reads as "audited". These tests run the real script.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, base64urlnopad } from "@scure/base";
import { describe, expect, it } from "vitest";

import {
  OFFER_ROOM,
  dealRoom,
  encodeFrame,
  generateHashLock,
  makeAccept,
  makeHeartbeat,
  makeOffer,
} from "../src/index.js";

const NOW = 1_735_000_000_000;

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)!.map((part) => Number.parseInt(part, 16)));
}

function identity(seedHex: string) {
  const seed = bytes(seedHex);
  const tagged = Uint8Array.from([0xed, 0x01, ...ed25519.getPublicKey(seed)]);
  return {
    did: `did:key:z${base58.encode(tagged)}`,
    sign: (canonical: string) =>
      base64urlnopad.encode(ed25519.sign(new TextEncoder().encode(canonical), seed)),
  };
}

const payer = identity("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
const payee = identity("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb");

function row(room: string, seq: number, timestampMs: number, signer: typeof payer, line: string) {
  const nonce = String(10_000 + seq);
  return JSON.stringify({
    seq,
    ts: new Date(timestampMs).toISOString(),
    from: signer.did,
    nonce,
    sig: signer.sign(`${room}|${nonce}|${line}`),
    text: line,
  });
}

function fixture() {
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
  const accept = makeAccept(offer, { from: payee.did, statement: lock.hash, nonce: "8899aabbccddeeff" });
  const room = dealRoom(accept.contract);

  const board = [
    row(OFFER_ROOM, 1, NOW - 2, payer, encodeFrame(offer)),
    row(OFFER_ROOM, 2, NOW - 1, payee, encodeFrame(accept)),
  ].join("\n");

  const beat = row(room, 1, NOW, payer, encodeFrame(makeHeartbeat({ from: payer.did, contract: accept.contract })));
  const rest = [
    row(room, 2, NOW + 1, payer, encodeFrame({
      type: "lock", from: payer.did, contract: accept.contract, rail: "flop-htlc", ref: "escrow-42",
    })),
    row(room, 3, NOW + 2, payee, encodeFrame({
      type: "reveal", from: payee.did, contract: accept.contract, secret: lock.preimage,
    })),
    row(room, 4, NOW + 3, payer, encodeFrame({
      type: "receipt", from: payer.did, contract: accept.contract, outcome: "claimed",
    })),
  ];
  return { contract: accept.contract, board, whole: [beat, ...rest].join("\n"), censored: rest.join("\n") };
}

function run(board: string, deal: string, contract: string) {
  const dir = mkdtempSync(join(tmpdir(), "tclk-audit-"));
  const boardFile = join(dir, "offers.jsonl");
  const dealFile = join(dir, "deal.jsonl");
  writeFileSync(boardFile, board);
  writeFileSync(dealFile, deal);
  // stderr matters on BOTH paths: the defect this guards against is a warning that prints
  // while the process still exits 0, so a helper that drops stderr on success cannot see it.
  const r = spawnSync(
    process.execPath,
    ["examples/audit-export.mjs", boardFile, dealFile, contract],
    { encoding: "utf8" },
  );
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("audit-export evidence contract", () => {
  it("exits 0 and replays claimed on a whole derived-room transcript", () => {
    const f = fixture();
    const r = run(f.board, f.whole, f.contract);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("replay → claimed");
    expect(r.stderr).not.toContain("no authenticated seq 1");
  });

  it("exits 1 and says INCOMPLETE when the derived room's opening row is absent", () => {
    const f = fixture();
    const r = run(f.board, f.censored, f.contract);
    // The rows that remain are 2,3,4: contiguous, all signatures valid, replay still reaches
    // claimed. Only the prefix anchor separates this from a whole transcript.
    // The warning alone is not the contract. Before the fix it printed here and the process
    // still exited 0, which reads to a user as "audited".
    expect(r.stderr).toContain("no authenticated seq 1");
    expect(r.stderr).not.toContain("gap detected");
    expect(r.stdout).not.toContain("replay → claimed");
    expect(r.stderr).toContain("evidence → INCOMPLETE");
    expect(r.code).toBe(1);
  });
});
