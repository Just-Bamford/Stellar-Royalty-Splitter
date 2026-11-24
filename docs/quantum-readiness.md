# Quantum Readiness (Post-Quantum Migration)

**Status:** Phase 0 → Phase 1 in progress. Hybrid signing infrastructure (`backend/src/crypto/post-quantum.js`) is implemented; integration into request verification middleware is planned (Phase 1).

## Why

Ed25519 (used by Stellar accounts) and ECDSA/secp256k1 are secure against
classical computers but are broken by **Shor's algorithm** on a sufficiently
large, fault-tolerant quantum computer. Signatures made today may need to remain
verifiable for decades, so the project prepares a **hybrid** signing scheme now:
a payload is signed with the classical key **and** a post-quantum key, and
verification requires both halves to pass. A forged hybrid signature has to
defeat Ed25519 _and_ the PQ primitive, so the system stays secure even if one of
them is later broken.

This work is "preparation": it selects algorithms, adds a hybrid signer, and
documents the migration. On-chain (Soroban) post-quantum support is explicitly
**out of scope** and tracked separately.

## Algorithm selection

| Role                     | Algorithm             | Standard | Keys   | Signature | Notes                                      |
| ------------------------ | --------------------- | -------- | ------ | --------- | ------------------------------------------ |
| Classical                | Ed25519               | RFC 8032 | 32 B   | 64 B      | Stellar's curve; kept for compatibility    |
| PQ primary               | **ML-DSA-44**         | FIPS 204 | 1312 B | 2420 B    | Lattice-based; fast, compact, many-time    |
| PQ long-term             | **SLH-DSA-SHA2-128s** | FIPS 205 | 32 B   | 7856 B    | Hash-based; conservative, large signatures |
| PQ key exchange (future) | ML-KEM-768            | FIPS 203 | —      | —         | For future encrypted channels              |

**Primary choice: ML-DSA-44 (CRYSTALS-Dilithium).** It is the NIST-standardized
lattice signature, has small keys and fast verification, and is well suited to
request signing. **SLH-DSA (SPHINCS+)** is offered as a second, hash-based option
for long-term archives because its security relies only on hash functions, at
the cost of much larger signatures. Both are implemented in the audited,
dependency-light [`@noble/post-quantum`](https://github.com/paulmillr/noble-post-quantum)
library (which also backs the `@noble/*` primitives already used by
`@stellar/stellar-sdk`).

## Hybrid design

`backend/src/crypto/post-quantum.js` exposes:

```js
import {
  generateHybridKeypair,
  signHybrid,
  verifyHybrid,
} from "./crypto/post-quantum.js";

const { publicKey, secretKey } = generateHybridKeypair(); // "ml-dsa-44"
const signature = signHybrid(canonicalRequest, secretKey);
verifyHybrid(signature, canonicalRequest, publicKey); // true only if BOTH halves pass
```

- The message is **domain-separated** (`stellar-royalty-splitter/hybrid-signature/v1`),
  so a hybrid signature cannot be replayed as a different protocol's signature.
- Keys and signatures use a **versioned, length-prefixed** encoding so new
  schemes can be added without breaking existing material:

  ```
  public key:  ver(1) | schemeId(1) | ed25519Pk(32) | u16be(pqPkLen) | pqPk
  secret key:  ver(1) | schemeId(1) | ed25519Sk(32) | u16be(pqSkLen) | pqSk
  signature:   ver(1) | schemeId(1) | u16be(clSigLen) | clSig | u16be(pqSigLen) | pqSig
  ```

- Verification fails closed: malformed input, unsupported version/scheme, and
  wrong keys all return `false` rather than throwing.

## Migration path

| Phase                       | Status      | Behaviour                                                                                                                                                          |
| --------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **0 — today**               | shipped     | Ed25519 only (`backend/src/verify-signature.js`).                                                                                                                  |
| **1 — hybrid**              | this change | Clients may attach a PQ/public key and a hybrid signature. Verification accepts hybrids **and** legacy Ed25519, and requires both halves when a hybrid is present. |
| **2 — deprecate classical** | planned     | Emit a deprecation warning/telemetry when a request is verified with Ed25519 only; require hybrid for high-value operations.                                       |
| **3 — post-quantum only**   | planned     | Reject classical-only signatures; retain ML-DSA or SLH-DSA based on the security policy.                                                                           |

### Phase 1 integration sketch

The request-signing middleware (`backend/src/verify-signature.js`) already
canonicalises a request into `METHOD\nPATH\nTIMESTAMP\nNONCE\nBODY_SHA256`. To
extend it to hybrids, add optional headers and verify with
`verifyHybrid(...)` when they are present:

```js
// X-Signature       — Ed25519 hex (legacy) OR hybrid hex (Phase 1)
// X-Signed-By       — Stellar G... key (legacy) OR hybrid public key hex
// X-PQ-Scheme       — optional: "ml-dsa-44" | "slh-dsa-sha2-128s"
if (isHybrid(xSignature)) {
  ok = verifyHybrid(xSignature, buildSignedString(...), xHybridPublicKey);
} else {
  ok = legacyEd25519Verify(...);
}
```

Because the hybrid encoding is self-describing (version + scheme id), the
middleware does not need to know the algorithm ahead of time.

## Performance

Measured on Node 24 (see `backend/tests/post-quantum.test.js`):

| Operation                | Approx. cost |
| ------------------------ | ------------ |
| Ed25519 verify           | ~0.1 ms      |
| ML-DSA-44 verify         | ~0.3–1 ms    |
| SLH-DSA-SHA2-128s verify | ~1–3 ms      |

Hybrid verification adds ~0.3–1 ms of CPU per request versus Ed25519-only — far
below the <20% end-to-end latency budget for the request handlers, where the
cryptographic check is a small fraction of total request time. Signature and key
sizes grow (see the table above); transport uses hex, so budget roughly 2× the
byte sizes.

## Out of scope / follow-ups

- Soroban/host support for post-quantum primitives (waiting on the Stellar
  protocol; see the issue's "Out" scope).
- Persistent hybrid key storage and key rotation.
- ML-KEM based transport encryption for sensitive exports.

## References

- FIPS 203 — ML-KEM (key encapsulation)
- FIPS 204 — ML-DSA (lattice signatures)
- FIPS 205 — SLH-DSA (hash-based signatures)
- NIST IR 8547 — Transition to Post-Quantum Cryptography Standards
- `@noble/post-quantum` — auditable JS implementation
