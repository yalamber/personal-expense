const encoder = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(input)));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/** Signs `payload` with the secret; returns `payload.signature` (both base64url). */
export async function sign(secret: string, payload: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return `${payload}.${base64url(sig)}`;
}

/** Returns the payload if the signature is valid, otherwise null. */
export async function verify(secret: string, signed: string): Promise<string | null> {
  const dot = signed.lastIndexOf(".");
  if (dot < 0) return null;
  const payload = signed.slice(0, dot);
  const sig = signed.slice(dot + 1);
  const key = await hmacKey(secret);
  let sigBytes: Uint8Array;
  try {
    sigBytes = fromBase64url(sig);
  } catch {
    return null;
  }
  const ok = await crypto.subtle.verify("HMAC", key, sigBytes, encoder.encode(payload));
  return ok ? payload : null;
}

export function base64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
