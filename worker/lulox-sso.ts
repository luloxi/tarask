/**
 * Lulox single sign-on: one Google login in Genkilulox (genki.lulox.com.ar) signs a
 * `lulox_sso` cookie for the parent domain (Domain=.lulox.com.ar, Secure, HttpOnly,
 * SameSite=Lax). Each service verifies it here and still applies its own allowlist.
 *
 * Value: base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload, LULOX_SSO_SECRET)).
 * Payload: { v: 1, email, name, picture, iat, exp } with times in ms.
 * Only Genkilulox issues it; services only verify. The secret is a `wrangler secret`.
 */
export const SSO_COOKIE = "lulox_sso";
export const SSO_DOMAIN = ".lulox.com.ar";

export type SsoUser = { email: string; name: string; picture: string };

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** Signs a cookie value (Genkilulox only). */
export async function signSso(user: SsoUser, secret: string, ttlMs: number, now = Date.now()): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify({ v: 1, email: user.email.trim().toLowerCase(), name: user.name, picture: user.picture, iat: now, exp: now + ttlMs })));
  return `${payload}.${b64url(await hmac(secret, payload))}`;
}

/** Verified user from the request's lulox_sso cookie, or null. Never throws. */
export async function readSso(request: Request, secret: string | undefined, now = Date.now()): Promise<SsoUser | null> {
  if (!secret || secret.length < 32) return null;
  const raw = cookieValue(request.headers.get("cookie"), SSO_COOKIE);
  if (!raw || raw.length > 4096) return null;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig) return null;
  try {
    if (!sameBytes(await hmac(secret, payload), fromB64url(sig))) return null;
    const data = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as { v?: number; email?: unknown; name?: unknown; picture?: unknown; iat?: unknown; exp?: unknown };
    if (data.v !== 1 || typeof data.email !== "string" || !data.email.includes("@")) return null;
    if (typeof data.exp !== "number" || data.exp <= now) return null;
    if (typeof data.iat !== "number" || data.iat > now + 60_000) return null;
    return { email: data.email.trim().toLowerCase(), name: typeof data.name === "string" ? data.name : "", picture: typeof data.picture === "string" ? data.picture : "" };
  } catch {
    return null;
  }
}

export function ssoSetCookie(value: string, maxAgeSeconds: number): string {
  return `${SSO_COOKIE}=${value}; Domain=${SSO_DOMAIN}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function ssoClearCookie(): string {
  return `${SSO_COOKIE}=; Domain=${SSO_DOMAIN}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
