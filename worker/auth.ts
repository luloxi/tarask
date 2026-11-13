import type { Env } from "./env";
import { readSso, ssoClearCookie, type SsoUser } from "./lulox-sso";
import {
  OAUTH_COOKIE,
  base64url,
  clearSessionCookie,
  json,
  randomToken,
  readCookie,
  readSessionCookie,
  redirect,
  serializeCookie,
  sessionCookie,
  sha256Hex,
} from "./http";

export const ADMIN_EMAIL = "lucianoolivabianco@gmail.com";
/** Set when the user leaves on purpose: lulox_sso must not sign them back in until they choose to. */
export const SSO_OFF_COOKIE = "tarask_sso_off";
// Callback registered in Google Cloud on tarask. The old cuentix host still 301s its callback here for in-flight logins.
const REDIRECT_URI = "https://tarask.lulox.com.ar/api/auth/callback/google";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const OAUTH_TTL_MS = 10 * 60 * 1000;

export type SessionUser = {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
};

type OAuthState = {
  s: string;
  v: string;
  e: number;
};

/**
 * Cookie session only. Bearer is not a session: `/api/svc/*` checks
 * `MCP_SERVICE_TOKEN` on its own, and `POST /api/balances` checks
 * `BALANCES_TOKEN` on its own. Every other route ignores Authorization.
 * One indexed lookup: auth_session.token is UNIQUE, joined to auth_user.
 * Allowlist is enforced at login, not on this hot path.
 */
export async function requireUser(req: Request, env: Env): Promise<SessionUser | Response> {
  const token = readSessionCookie(req);
  if (!token) return (await ssoUser(req, env)) ?? json({ error: "No autenticado" }, 401);
  const tokenHash = await sha256Hex(token);
  const sso = await activeSso(req, env);
  const row = await env.DB.prepare(
    `SELECT u.id AS id, u.email AS email, u.name AS name, u.image AS image
     FROM auth_session s
     INNER JOIN auth_user u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > ?
     LIMIT 1`,
  )
    .bind(tokenHash, Date.now())
    .first<SessionUser>();
  if (!row?.id || !row.email) return (await ssoUser(req, env)) ?? json({ error: "No autenticado" }, 401);
  if (sso && sso.email !== row.email.trim().toLowerCase()) {
    // The Genkilulox login is another person than this Tarask session (same browser, account switched):
    // never show the old account. Drop that session and follow the current Genki identity, if it is allowed here.
    await env.DB.prepare("DELETE FROM auth_session WHERE token = ?").bind(tokenHash).run();
    return (await ssoUser(req, env)) ?? json({ error: "No autenticado" }, 401, [clearSessionCookie(req)]);
  }
  return row;
}

/** The verified Genkilulox identity for this request, unless the user signed out of Tarask on purpose. */
async function activeSso(req: Request, env: Env): Promise<SsoUser | null> {
  if (readCookie(req, SSO_OFF_COOKIE) === "1") return null;
  return readSso(req, env.LULOX_SSO_SECRET);
}

/**
 * Single sign-on from Genkilulox: a valid `lulox_sso` cookie (HMAC + expiry checked in
 * lulox-sso.ts) counts as a session only for an email that is on Tarask's own allowlist
 * and already has a Tarask user (first login stays the Google flow here).
 */
async function ssoUser(req: Request, env: Env): Promise<SessionUser | null> {
  const sso = await activeSso(req, env);
  if (!sso || !(await isEmailAllowed(env, sso.email))) return null;
  const row = await env.DB.prepare("SELECT id, email, name, image FROM auth_user WHERE email = ? LIMIT 1").bind(sso.email).first<SessionUser>();
  return row?.id ? row : null;
}

export function isUser(value: SessionUser | Response): value is SessionUser {
  return !(value instanceof Response);
}

export async function handleGoogleStart(req: Request, env: Env): Promise<Response> {
  const state = randomToken(16);
  const verifier = randomToken(32);
  const challenge = await sha256Base64Url(verifier);
  const payload: OAuthState = { s: state, v: verifier, e: Date.now() + OAUTH_TTL_MS };
  const cookie = await signOAuthCookie(payload, env, req);
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID ?? "",
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  // Starting a sign-in is a deliberate choice: SSO may work again after it.
  return redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    [cookie, serializeCookie(SSO_OFF_COOKIE, "", req, 0)],
  );
}

export async function handleGoogleCallback(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");
  const clear = serializeCookie(OAUTH_COOKIE, "", req, 0);
  if (oauthError || !code || !state) {
    return redirect("/login?error=oauth", [clear]);
  }
  const saved = await readOAuthCookie(req, env);
  if (!saved || saved.s !== state || saved.e < Date.now()) {
    return redirect("/login?error=oauth", [clear]);
  }
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return redirect("/login?error=auth_not_configured", [clear]);
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
      code_verifier: saved.v,
    }),
  });
  if (!tokenRes.ok) return redirect("/login?error=oauth", [clear]);
  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  if (!tokenJson.access_token) return redirect("/login?error=oauth", [clear]);

  const profileRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${tokenJson.access_token}` },
  });
  if (!profileRes.ok) return redirect("/login?error=oauth", [clear]);
  const profile = (await profileRes.json()) as {
    email?: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
  };
  const email = profile.email?.trim().toLowerCase() ?? "";
  if (!email || profile.email_verified !== true) {
    return redirect("/login?error=unverified", [clear]);
  }
  if (!(await isEmailAllowed(env, email))) {
    return redirect("/login?error=forbidden", [clear]);
  }

  const user = await upsertUser(env, {
    email,
    name: profile.name?.trim() || email,
    image: profile.picture ?? null,
  });
  const session = await createSession(env, user.id, req);
  const cookies = [clear, session, serializeCookie(SSO_OFF_COOKIE, "", req, 0)];
  // Signed in with a different Google account than the one Genkilulox holds: the deliberate login wins,
  // so drop the shared cookie instead of letting it overrule this session on the next request.
  const sso = await readSso(req, env.LULOX_SSO_SECRET);
  if (sso && sso.email !== email) cookies.push(ssoClearCookie());
  return redirect("/dashboard", cookies);
}

export async function handleLogout(req: Request, env: Env): Promise<Response> {
  const token = readSessionCookie(req);
  if (token) {
    const tokenHash = await sha256Hex(token);
    await env.DB.prepare("DELETE FROM auth_session WHERE token = ?").bind(tokenHash).run();
  }
  // Leaving Tarask also ends the shared login, or the SSO cookie would sign you right back in.
  return json({ ok: true }, 200, [clearSessionCookie(req), ssoClearCookie(), serializeCookie(SSO_OFF_COOKIE, "1", req, 24 * 60 * 60)]);
}

async function isEmailAllowed(env: Env, email: string): Promise<boolean> {
  if (email === ADMIN_EMAIL) return true;
  const fromEnv = (env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (fromEnv.includes(email)) return true;
  const row = await env.DB.prepare(
    "SELECT email FROM allowed_emails WHERE email = ? LIMIT 1",
  )
    .bind(email)
    .first<{ email: string }>();
  return Boolean(row);
}

async function upsertUser(
  env: Env,
  profile: { email: string; name: string; image: string | null },
): Promise<SessionUser> {
  const existing = await env.DB.prepare(
    "SELECT id, email, name, image FROM auth_user WHERE email = ? LIMIT 1",
  )
    .bind(profile.email)
    .first<SessionUser>();
  const now = Date.now();
  if (existing) {
    await env.DB.prepare(
      "UPDATE auth_user SET name = ?, image = ?, email_verified = 1, updated_at = ? WHERE id = ?",
    )
      .bind(profile.name, profile.image, now, existing.id)
      .run();
    await ensureAppUser(env, {
      id: existing.id,
      email: profile.email,
      name: existing.name || profile.name,
      image: profile.image,
    });
    return {
      id: existing.id,
      email: profile.email,
      name: existing.name,
      image: profile.image,
    };
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO auth_user (id, name, email, email_verified, image, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, ?)`,
  )
    .bind(id, profile.name, profile.email, profile.image, now, now)
    .run();
  await ensureAppUser(env, {
    id,
    email: profile.email,
    name: profile.name,
    image: profile.image,
  });
  return { id, email: profile.email, name: profile.name, image: profile.image };
}

async function ensureAppUser(
  env: Env,
  user: { id: string; email: string; name: string | null; image: string | null },
): Promise<void> {
  const byId = await env.DB.prepare("SELECT id, image FROM users WHERE id = ? LIMIT 1")
    .bind(user.id)
    .first<{ id: string; image: string | null }>();
  if (byId) {
    await env.DB.prepare("UPDATE users SET email = ?, image = ? WHERE id = ?")
      .bind(user.email, byId.image ?? user.image, user.id)
      .run();
    return;
  }
  const byEmail = await env.DB.prepare("SELECT id FROM users WHERE email = ? LIMIT 1")
    .bind(user.email)
    .first<{ id: string }>();
  if (byEmail) return;
  await env.DB.prepare(
    "INSERT INTO users (id, name, email, image, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(user.id, user.name, user.email, user.image, Date.now())
    .run();
}

async function createSession(env: Env, userId: string, req: Request): Promise<string> {
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO auth_session
       (id, expires_at, token, created_at, updated_at, ip_address, user_agent, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      now + SESSION_MS,
      tokenHash,
      now,
      now,
      req.headers.get("cf-connecting-ip"),
      req.headers.get("user-agent")?.slice(0, 200) ?? null,
      userId,
    )
    .run();
  return sessionCookie(token, req);
}

async function sha256Base64Url(value: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64url(new Uint8Array(buf));
}

async function signOAuthCookie(payload: OAuthState, env: Env, req: Request): Promise<string> {
  const body = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = env.BETTER_AUTH_SECRET
    ? await hmac(env.BETTER_AUTH_SECRET, body)
    : "unsigned";
  return serializeCookie(OAUTH_COOKIE, `${body}.${sig}`, req, Math.ceil(OAUTH_TTL_MS / 1000));
}

async function readOAuthCookie(req: Request, env: Env): Promise<OAuthState | null> {
  const raw = readCookie(req, OAUTH_COOKIE);
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (env.BETTER_AUTH_SECRET) {
    const expected = await hmac(env.BETTER_AUTH_SECRET, body);
    if (expected !== sig) return null;
  } else if (sig !== "unsigned") {
    return null;
  }
  try {
    const jsonText = new TextDecoder().decode(base64urlDecode(body));
    const parsed = JSON.parse(jsonText) as OAuthState;
    if (!parsed?.s || !parsed.v || typeof parsed.e !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64url(new Uint8Array(sig));
}

function base64urlDecode(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
