export function newId(): string {
  return crypto.randomUUID();
}

const TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** URL- and email-safe random token (lower case letters and digits). */
export function randomToken(length = 24): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += TOKEN_ALPHABET[b % TOKEN_ALPHABET.length];
  return out;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function isoInMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}
