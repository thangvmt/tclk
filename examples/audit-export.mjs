#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Reproduce a deal from two byte-exact technocore exports, with no network access.
//
//   node examples/audit-export.mjs offers.jsonl deal.jsonl 0x<contract-id>

import { readFileSync } from "node:fs";

import {
  OFFER_ROOM,
  dealRoom,
  findContractHandshake,
  foldTranscript,
  parseTranscriptExport,
} from "../dist/index.js";

const [offersFile, dealFile, contract] = process.argv.slice(2);
if (!offersFile || !dealFile || !/^0x[0-9a-f]{64}$/.test(contract ?? "")) {
  console.error("usage: audit-export.mjs <offers.jsonl> <deal.jsonl> <0x contract id>");
  process.exit(2);
}

const room = dealRoom(contract);
const board = parseTranscriptExport(OFFER_ROOM, readFileSync(offersFile, "utf8"));
const deal = parseTranscriptExport(room, readFileSync(dealFile, "utf8"));

let handshake;
try {
  handshake = findContractHandshake(board, contract);
} catch (error) {
  console.error(error instanceof Error ? error.message : "invalid offer/accept ordering");
  process.exit(1);
}
if (handshake === null) {
  console.error(`no authenticated offer/accept pair for ${contract}`);
  process.exit(1);
}

if (deal.length === 0) {
  console.log(`\n${room}: no rows in this file.`);
  console.log("  An empty deal room reads the same whether it was censored or simply expired:");
  console.log("  the venue deletes a room after seven days with no write, and a terminal deal");
  console.log("  stops writing. Absence here is not a finding either way.");
}

const folded = foldTranscript([handshake.offer, handshake.accept, ...deal]);
for (const step of folded.steps) {
  const verdict = step.ok ? "ok " : "BAD";
  console.log(`${verdict} ${step.room}#${step.seq} ${step.type ?? "record"}${step.reason ? ` — ${step.reason}` : ""}`);
}

if (folded.warnings?.length) {
  console.error("\nwarnings (timestamps/seq are venue metadata, not signed — see SPEC §2):");
  for (const w of folded.warnings) console.error(`  WARN: ${w}`);
  // A gap or reordering can flip claimed↔refunded with no BAD verdict (see #93).
  // A backwards timestamp can flip a deadline with all signatures valid.
  // A missing seq 1 in a derived-convention room is the same class of defect as a gap: a signed
  // row the file does not carry. It has no surviving predecessor, so the pairwise walk above
  // stays silent on it, which is exactly why it has to be fatal here too.
  const fatal = folded.warnings.some((w) => w.includes("gap detected") || w.includes("seq not strictly increasing") || w.includes("timestamp goes backwards") || w.includes("no authenticated seq 1"));
  if (fatal) {
    console.error("\nevidence → INCOMPLETE: transcript is not per-room contiguous/monotonic — a signed row is missing or reordered. Refusing to treat fold as audit proof");
    process.exit(1);
  }
}

if (folded.state === null) {
  console.error("no authenticated contract could be opened");
  process.exit(1);
}

const terminal = ["claimed", "refunded", "cancelled"].includes(folded.state.status);
console.log(`\nreplay → ${folded.state.status}${terminal ? "" : " (not terminal)"}`);
console.log("evidence → completeness NOT established. A gap is evidence of absence; the absence of a gap is not evidence of presence, because seq/ts are venue metadata outside the signature (room|nonce|line only). Exit 0 means the replay reached a terminal status. It does not mean audited — verify settlement on the rail.");
process.exit(terminal ? 0 : 1);
