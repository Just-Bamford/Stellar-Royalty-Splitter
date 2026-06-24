/** Commit-reveal hashing for initialize (#403) — must match on-chain contract. */

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(digest);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function generateInitSalt(): Uint8Array {
  const salt = new Uint8Array(32);
  crypto.getRandomValues(salt);
  return salt;
}

export function generateInitNonce(): Uint8Array {
  const nonce = new Uint8Array(32);
  crypto.getRandomValues(nonce);
  return nonce;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.replace(/^0x/i, "");
  const out = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export async function hashCollaborators(
  collaborators: string[],
  salt: Uint8Array,
): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const chunks = [salt, ...collaborators.map((c) => enc.encode(c))];
  return sha256(concatBytes(chunks));
}

export async function hashShares(shares: number[], salt: Uint8Array): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [salt];
  for (const share of shares) {
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setUint32(0, share, false);
    chunks.push(buf);
  }
  return sha256(concatBytes(chunks));
}

export const INIT_COMMIT_STORAGE_KEY = "srs_init_commit";

export interface InitCommitState {
  contractId: string;
  saltHex: string;
  nonceHex: string;
  collaboratorsHashHex: string;
  sharesHashHex: string;
  committedAt: string;
}
