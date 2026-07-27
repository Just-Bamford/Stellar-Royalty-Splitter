/**
 * RFC 6238 TOTP helpers (HMAC-SHA1, 30s step, 6 digits).
 * Pure Node crypto — no third-party OTP dependency.
 */
import { createHmac, createHash, randomBytes, timingSafeEqual } from "crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const DIGITS = 6;

export function generateTotpSecret(bytes = 20) {
  return base32Encode(randomBytes(bytes));
}

export function buildOtpAuthUri({
  secret,
  accountName,
  issuer = "Stellar Royalty Splitter",
}) {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export function generateTotp(secret, atMs = Date.now()) {
  const counter = Math.floor(atMs / 1000 / STEP_SECONDS);
  return hotp(secret, counter);
}

/**
 * Verify a 6-digit TOTP.
 * @param {object} options
 * @param {string} options.secret base32 secret
 * @param {string} options.token user-provided code
 * @param {number} [options.atMs] clock override for tests
 * @param {number} [options.window] allowed steps either side (default 1)
 * @param {boolean} [options.allowExpired] when false, only exact current step (for expired tests)
 */
export function verifyTotp({
  secret,
  token,
  atMs = Date.now(),
  window = 1,
  allowExpired = true,
}) {
  const normalized = String(token ?? "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(normalized)) return false;

  const currentCounter = Math.floor(atMs / 1000 / STEP_SECONDS);
  const maxWindow = allowExpired ? window : 0;

  for (let offset = -maxWindow; offset <= maxWindow; offset++) {
    const expected = hotp(secret, currentCounter + offset);
    if (secureCompare(expected, normalized)) return true;
  }
  return false;
}

/**
 * Treat a code as expired when it only matches a previous step outside the
 * current window — useful for acceptance tests.
 */
export function isExpiredTotp({ secret, token, atMs = Date.now(), staleSteps = 2 }) {
  const normalized = String(token ?? "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(normalized)) return false;

  const currentCounter = Math.floor(atMs / 1000 / STEP_SECONDS);
  const stale = hotp(secret, currentCounter - staleSteps);
  const current = verifyTotp({ secret, token: normalized, atMs, window: 1 });
  return secureCompare(stale, normalized) && !current;
}

export function generateBackupCodes(count = 10) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const raw = randomBytes(5).toString("hex").toUpperCase();
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}

export function hashBackupCode(code) {
  return createHash("sha256").update(normalizeBackupCode(code)).digest("hex");
}

export function normalizeBackupCode(code) {
  return String(code ?? "").replace(/[\s-]/g, "").toUpperCase();
}

function hotp(secret, counter) {
  const key = base32Decode(secret);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));

  const hmac = createHmac("sha1", key).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(code % 10 ** DIGITS).padStart(DIGITS, "0");
}

function secureCompare(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

function base32Decode(secret) {
  const cleaned = String(secret).replace(/=+$/g, "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const bytes = [];

  for (const char of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error("Invalid base32 secret");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}
