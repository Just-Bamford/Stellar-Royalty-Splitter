/**
 * Post-quantum hybrid signature preparation (#1039).
 *
 * Long-term threat model
 * ----------------------
 * Stellar uses Ed25519 (and Soroban exposes ECDSA/secp256k1). Both are broken
 * by Shor's algorithm on a sufficiently large quantum computer. Signatures made
 * today may need to remain verifiable for decades, so we prepare a *hybrid*
 * scheme: a payload is signed with the classical Ed25519 key **and** a
 * post-quantum key, and verification requires **both** halves to pass. A forged
 * hybrid signature therefore has to defeat Ed25519 *and* the PQ scheme, so the
 * system stays secure even if either primitive is later broken.
 *
 * Algorithms (selection rationale in docs/quantum-readiness.md)
 * -------------------------------------------------------------
 *   - classical:        Ed25519 (Stellar's curve) — 32-byte keys, 64-byte sigs
 *   - PQ primary:       ML-DSA-44 (FIPS 204, lattice-based) — fast, compact
 *   - PQ long-term:     SLH-DSA-SHA2-128s (FIPS 205, hash-based) — conservative
 *
 * Wire format
 * -----------
 * Keys and signatures are length-prefixed, versioned byte strings (hex-encoded
 * for transport) so additional schemes can be added without breaking existing
 * keys or signatures:
 *
 *   public key:  ver(1) | schemeId(1) | ed25519Pk(32) | u16be(pqPkLen) | pqPk
 *   secret key:  ver(1) | schemeId(1) | ed25519Sk(32) | u16be(pqSkLen) | pqSk
 *   signature:   ver(1) | schemeId(1) | u16be(clSigLen) | clSig | u16be(pqSigLen) | pqSig
 *
 * The signed message is domain-separated so a signature produced here can never
 * be replayed as a different protocol's signature.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { slh_dsa_sha2_128s } from "@noble/post-quantum/slh-dsa.js";

/** Wire-format version for hybrid keys and signatures. */
export const HYBRID_VERSION = 1;

/** Domain-separation tag mixed into every signed message. */
export const HYBRID_DOMAIN = "stellar-royalty-splitter/hybrid-signature/v1";

/** Length of an Ed25519 public key / secret key in bytes. */
export const ED25519_KEY_LENGTH = 32;

/** Length of an Ed25519 signature in bytes. */
export const ED25519_SIGNATURE_LENGTH = 64;

/**
 * Supported post-quantum signature schemes. `id` is the stable on-the-wire
 * identifier; never renumber an existing entry.
 */
export const PQ_SCHEMES = Object.freeze({
  "ml-dsa-44": Object.freeze({
    id: 1,
    signer: ml_dsa44,
    kind: "lattice",
    label: "ML-DSA-44 (FIPS 204)",
  }),
  "slh-dsa-sha2-128s": Object.freeze({
    id: 2,
    signer: slh_dsa_sha2_128s,
    kind: "hash",
    label: "SLH-DSA-SHA2-128s (FIPS 205)",
  }),
});

/** Scheme used unless a caller selects another. */
export const DEFAULT_PQ_SCHEME = "ml-dsa-44";

/** Names of every supported scheme, in registration order. */
export const SUPPORTED_PQ_SCHEMES = Object.freeze(Object.keys(PQ_SCHEMES));

function schemeByName(name) {
  const scheme = PQ_SCHEMES[name];
  if (!scheme) {
    throw new Error(
      `Unknown post-quantum scheme "${name}". Supported: ${SUPPORTED_PQ_SCHEMES.join(", ")}`
    );
  }
  return { name, ...scheme };
}

function schemeById(id) {
  for (const name of SUPPORTED_PQ_SCHEMES) {
    if (PQ_SCHEMES[name].id === id) return { name, ...PQ_SCHEMES[name] };
  }
  return null;
}

function toBytes(value) {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new TypeError("message must be a string, Buffer, or Uint8Array");
}

function fromHex(hex, label) {
  if (typeof hex !== "string" || hex.length === 0 || hex.length % 2 !== 0) {
    throw new Error(`${label} must be a non-empty, even-length hex string`);
  }
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(`${label} must be a hex string`);
  }
  return Buffer.from(hex, "hex");
}

function u16be(value) {
  const buf = Buffer.allocUnsafe(2);
  buf.writeUInt16BE(value, 0);
  return buf;
}

/**
 * Domain-separated message actually covered by both signatures.
 * @param {string|Buffer|Uint8Array} message
 * @returns {Buffer}
 */
export function hybridSignedMessage(message) {
  return Buffer.concat([Buffer.from(`${HYBRID_DOMAIN}\n`, "utf8"), toBytes(message)]);
}

/**
 * Generate a fresh hybrid (Ed25519 + post-quantum) keypair.
 *
 * @param {string} [scheme] - one of {@link SUPPORTED_PQ_SCHEMES}
 * @returns {{ scheme: string, publicKey: string, secretKey: string }} hex-encoded keys
 */
export function generateHybridKeypair(scheme = DEFAULT_PQ_SCHEME) {
  const selected = schemeByName(scheme);

  const classicalSecretKey = ed25519.utils.randomSecretKey();
  const classicalPublicKey = ed25519.getPublicKey(classicalSecretKey);

  const pq = selected.signer.keygen();
  const pqPublicKey = Buffer.from(pq.publicKey);
  const pqSecretKey = Buffer.from(pq.secretKey);

  const publicKey = Buffer.concat([
    Buffer.from([HYBRID_VERSION, selected.id]),
    Buffer.from(classicalPublicKey),
    u16be(pqPublicKey.length),
    pqPublicKey,
  ]);

  const secretKey = Buffer.concat([
    Buffer.from([HYBRID_VERSION, selected.id]),
    Buffer.from(classicalSecretKey),
    u16be(pqSecretKey.length),
    pqSecretKey,
  ]);

  return {
    scheme,
    publicKey: publicKey.toString("hex"),
    secretKey: secretKey.toString("hex"),
  };
}

/**
 * Parse a hex-encoded hybrid public key.
 * @returns {{ version: number, scheme: string, schemeId: number, classicalPublicKey: Buffer, pqPublicKey: Buffer }}
 */
export function parseHybridPublicKey(hex) {
  const buf = fromHex(hex, "hybrid public key");
  if (buf.length < 2) throw new Error("hybrid public key too short");
  const version = buf[0];
  if (version !== HYBRID_VERSION) throw new Error(`unsupported hybrid version ${version}`);
  const scheme = schemeById(buf[1]);
  if (!scheme) throw new Error(`unsupported post-quantum scheme id ${buf[1]}`);

  let offset = 2;
  if (offset + ED25519_KEY_LENGTH > buf.length) throw new Error("hybrid public key truncated");
  const classicalPublicKey = buf.subarray(offset, offset + ED25519_KEY_LENGTH);
  offset += ED25519_KEY_LENGTH;

  const pqField = readField(buf, offset, "hybrid public key");
  if (pqField.next !== buf.length) throw new Error("hybrid public key has trailing bytes");
  const pqPublicKey = pqField.value;
  const expectedPqLength = scheme.signer.lengths.publicKey;
  if (pqPublicKey.length !== expectedPqLength) {
    throw new Error(
      `hybrid public key has ${pqPublicKey.length}-byte PQ key, expected ${expectedPqLength}`
    );
  }

  return { version, scheme: scheme.name, schemeId: scheme.id, classicalPublicKey, pqPublicKey };
}

/**
 * Parse a hex-encoded hybrid secret key.
 * @returns {{ version: number, scheme: string, schemeId: number, classicalSecretKey: Buffer, pqSecretKey: Buffer }}
 */
export function parseHybridSecretKey(hex) {
  const buf = fromHex(hex, "hybrid secret key");
  if (buf.length < 2) throw new Error("hybrid secret key too short");
  const version = buf[0];
  if (version !== HYBRID_VERSION) throw new Error(`unsupported hybrid version ${version}`);
  const scheme = schemeById(buf[1]);
  if (!scheme) throw new Error(`unsupported post-quantum scheme id ${buf[1]}`);

  let offset = 2;
  if (offset + ED25519_KEY_LENGTH > buf.length) throw new Error("hybrid secret key truncated");
  const classicalSecretKey = buf.subarray(offset, offset + ED25519_KEY_LENGTH);
  offset += ED25519_KEY_LENGTH;

  const pqField = readField(buf, offset, "hybrid secret key");
  if (pqField.next !== buf.length) throw new Error("hybrid secret key has trailing bytes");
  const pqSecretKey = pqField.value;
  const expectedPqLength = scheme.signer.lengths.secretKey;
  if (pqSecretKey.length !== expectedPqLength) {
    throw new Error(
      `hybrid secret key has ${pqSecretKey.length}-byte PQ key, expected ${expectedPqLength}`
    );
  }

  return { version, scheme: scheme.name, schemeId: scheme.id, classicalSecretKey, pqSecretKey };
}

/**
 * Parse a hex-encoded hybrid signature.
 * @returns {{ version: number, scheme: string, schemeId: number, classicalSignature: Buffer, pqSignature: Buffer }}
 */
export function parseHybridSignature(hex) {
  const buf = fromHex(hex, "hybrid signature");
  if (buf.length < 2) throw new Error("hybrid signature too short");
  const version = buf[0];
  if (version !== HYBRID_VERSION) throw new Error(`unsupported hybrid version ${version}`);
  const scheme = schemeById(buf[1]);
  if (!scheme) throw new Error(`unsupported post-quantum scheme id ${buf[1]}`);

  let offset = 2;
  const classicalField = readField(buf, offset, "hybrid signature");
  const classicalSignature = classicalField.value;
  offset = classicalField.next;
  if (classicalSignature.length !== ED25519_SIGNATURE_LENGTH) {
    throw new Error(
      `hybrid signature has ${classicalSignature.length}-byte Ed25519 half, expected 64`
    );
  }

  const pqField = readField(buf, offset, "hybrid signature");
  if (pqField.next !== buf.length) throw new Error("hybrid signature has trailing bytes");
  const pqSignature = pqField.value;
  const expectedPqLength = scheme.signer.lengths.signature;
  if (pqSignature.length !== expectedPqLength) {
    throw new Error(
      `hybrid signature has ${pqSignature.length}-byte PQ half, expected ${expectedPqLength}`
    );
  }

  return { version, scheme: scheme.name, schemeId: scheme.id, classicalSignature, pqSignature };
}

function readField(buf, offset, label) {
  if (offset + 2 > buf.length) throw new Error(`${label} truncated`);
  const length = buf.readUInt16BE(offset);
  const start = offset + 2;
  const end = start + length;
  if (end > buf.length) throw new Error(`${label} truncated`);
  return { value: buf.subarray(start, end), next: end };
}

/**
 * Sign a message with both halves of a hybrid keypair.
 *
 * @param {string|Buffer|Uint8Array} message
 * @param {string} secretKey - hex-encoded hybrid secret key
 * @returns {string} hex-encoded hybrid signature (Ed25519 half + PQ half)
 */
export function signHybrid(message, secretKey) {
  const {
    schemeId,
    scheme: schemeName,
    classicalSecretKey,
    pqSecretKey,
  } = parseHybridSecretKey(secretKey);
  const scheme = schemeByName(schemeName);
  const signed = hybridSignedMessage(message);

  const classicalSignature = Buffer.from(ed25519.sign(signed, classicalSecretKey));
  const pqSignature = Buffer.from(scheme.signer.sign(signed, pqSecretKey));

  return Buffer.concat([
    Buffer.from([HYBRID_VERSION, schemeId]),
    u16be(classicalSignature.length),
    classicalSignature,
    u16be(pqSignature.length),
    pqSignature,
  ]).toString("hex");
}

/**
 * Verify a hybrid signature. Returns `true` only when **both** the Ed25519 and
 * post-quantum halves verify against the domain-separated message, so a break
 * in either primitive alone cannot forge a signature.
 *
 * Structural encoding errors (malformed hex/version/scheme) also return `false`
 * so callers can treat this as a plain verification predicate.
 *
 * @param {string} signature - hex-encoded hybrid signature
 * @param {string|Buffer|Uint8Array} message
 * @param {string} publicKey - hex-encoded hybrid public key
 * @returns {boolean}
 */
export function verifyHybrid(signature, message, publicKey) {
  let parsedSignature;
  let parsedPublicKey;
  try {
    parsedSignature = parseHybridSignature(signature);
    parsedPublicKey = parseHybridPublicKey(publicKey);
  } catch {
    return false;
  }

  if (parsedSignature.schemeId !== parsedPublicKey.schemeId) return false;

  const signed = hybridSignedMessage(message);
  const scheme = schemeById(parsedSignature.schemeId);

  let classicalOk = false;
  let pqOk = false;
  try {
    classicalOk = ed25519.verify(
      parsedSignature.classicalSignature,
      signed,
      parsedPublicKey.classicalPublicKey
    );
    pqOk = scheme.signer.verify(parsedSignature.pqSignature, signed, parsedPublicKey.pqPublicKey);
  } catch {
    return false;
  }

  return classicalOk && pqOk;
}

/**
 * Expected byte length of an encoded hybrid key or signature for a scheme.
 * Useful for storage/transport budgeting.
 */
export function hybridPublicKeySize(scheme = DEFAULT_PQ_SCHEME) {
  const selected = schemeByName(scheme);
  return 2 + ED25519_KEY_LENGTH + 2 + selected.signer.lengths.publicKey;
}

export function hybridSecretKeySize(scheme = DEFAULT_PQ_SCHEME) {
  const selected = schemeByName(scheme);
  return 2 + ED25519_KEY_LENGTH + 2 + selected.signer.lengths.secretKey;
}

export function hybridSignatureSize(scheme = DEFAULT_PQ_SCHEME) {
  const selected = schemeByName(scheme);
  return 2 + 2 + ED25519_SIGNATURE_LENGTH + 2 + selected.signer.lengths.signature;
}
