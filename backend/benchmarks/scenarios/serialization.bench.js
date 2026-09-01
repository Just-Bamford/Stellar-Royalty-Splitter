/**
 * Serialization benchmarks (#867).
 *
 * Why these paths: every contract invocation converts its arguments to ScVal
 * and encodes them to XDR. For a 50-operation batch that happens 150+ times
 * per request, so a small per-conversion regression is multiplied by the batch
 * size before the user sees it.
 *
 * These are deliberately the pure, network-free parts of the transaction
 * pipeline. Benchmarking `buildTx` itself would measure Horizon's latency.
 */

import { xdr, scValToNative } from "@stellar/stellar-sdk";

import {
  addressToScVal,
  u32ToScVal,
  i128ToScVal,
  vecToScVal,
} from "../../src/stellar.js";

const ACCOUNT = "GBDIA62PY5P5MSTMR3DSVAQ4TITI3JJWWMW2NAI2QZKMPTTKSLG5JU6L";

// A realistic distribution amount: 1 XLM in stroops.
const AMOUNT = 10_000_000n;

// Pre-built argument vector matching a 10-recipient distribute call, so the
// vec benchmark measures encoding rather than the cost of building its inputs.
const TEN_ARGS = Array.from({ length: 10 }, (_, i) => u32ToScVal(1000 + i));

const ENCODED_I128 = i128ToScVal(AMOUNT).toXDR("base64");
const ENCODED_VEC = vecToScVal(TEN_ARGS).toXDR("base64");

/** @type {import("../runner.js").Scenario[]} */
export default [
  {
    name: "serialization/address-to-scval",
    group: "serialization",
    description: "addressToScVal — runs once per address argument on every invocation",
    iterations: 200,
    batch: 500,
    warmup: 50,
    run: () => addressToScVal(ACCOUNT),
  },
  {
    name: "serialization/i128-to-scval",
    group: "serialization",
    description: "i128ToScVal on a realistic stroop amount",
    iterations: 200,
    batch: 500,
    warmup: 50,
    run: () => i128ToScVal(AMOUNT),
  },
  {
    name: "serialization/u32-to-scval",
    group: "serialization",
    description: "u32ToScVal on a basis-points value",
    iterations: 200,
    batch: 2000,
    warmup: 50,
    run: () => u32ToScVal(2500),
  },
  {
    name: "serialization/vec-encode/10-args",
    group: "serialization",
    description: "vecToScVal + XDR encode for a 10-argument vector",
    iterations: 200,
    batch: 1000,
    warmup: 50,
    run: () => vecToScVal(TEN_ARGS).toXDR("base64"),
  },
  {
    name: "serialization/i128-decode",
    group: "serialization",
    description: "XDR decode + scValToNative round trip for an i128",
    iterations: 200,
    batch: 200,
    warmup: 50,
    run: () => scValToNative(xdr.ScVal.fromXDR(ENCODED_I128, "base64")),
  },
  {
    name: "serialization/vec-decode/10-args",
    group: "serialization",
    description: "XDR decode for a 10-argument vector",
    iterations: 200,
    batch: 200,
    warmup: 50,
    run: () => xdr.ScVal.fromXDR(ENCODED_VEC, "base64").vec().length,
  },
  {
    name: "serialization/batch-args/50-operations",
    group: "serialization",
    description:
      "Full argument construction for a 50-operation batch — the shape of one /batch-distribute request",
    // The heaviest scenario here, and the most allocation-heavy, so its
    // samples are dominated by whether a GC lands inside them. More samples
    // spread that cost evenly across passes instead of concentrating it in a
    // few, which is what made this the last scenario to keep false-positiving
    // against unchanged code.
    iterations: 600,
    warmup: 100,
    run: () => {
      let encoded = 0;
      for (let i = 0; i < 50; i += 1) {
        const args = vecToScVal([addressToScVal(ACCOUNT), i128ToScVal(AMOUNT)]);
        encoded += args.toXDR("base64").length;
      }
      return encoded;
    },
  },
];
