// Shared helpers for Google OAuth + Gmail API (multi-account).
// Accounts are hard-coded via environment variables, so they are global to the
// deployment and appear on every device with no storage backend required.
// Any account added at runtime (OAuth / IMAP connect) is layered on top in a
// per-device cookie. See envAccounts() for the env format.

export const OAUTH_SCOPES = [
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
].join(' ');

export function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > -1) {
      const k = part.slice(0, i).trim();
      const v = part.slice(i + 1).trim();
      if (k) out[k] = decodeURIComponent(v);
    }
  });
  return out;
}

export function appendCookies(res, cookies) {
  const existing = res.getHeader('Set-Cookie');
  let arr = existing ? (Array.isArray(existing) ? existing : [existing]) : [];
  res.setHeader('Set-Cookie', arr.concat(cookies));
}

const ACCOUNTS_COOKIE = 'gv_accounts';
const ACTIVE_COOKIE = 'gv_active';
const ONE_YEAR = 60 * 60 * 24 * 365;

// ── Hard-coded accounts from environment variables ──
// These are global to the deployment, so they appear on every device.
//
// MAIL_ACCOUNTS — a JSON array, e.g.:
//   [
//     {"kind":"google","email":"me@gmail.com","name":"Me","refreshToken":"1//0g…"},
//     {"kind":"imap","service":"gmail","email":"me@school.org","name":"School","password":"app-password"}
//   ]
// Legacy single Google account (GMAIL_REFRESH_TOKEN / GMAIL_EMAIL) is also honored.
function envAccounts() {
  const out = [];
  if (process.env.MAIL_ACCOUNTS) {
    try {
      const arr = JSON.parse(process.env.MAIL_ACCOUNTS);
      if (Array.isArray(arr)) {
        for (const a of arr) {
          if (!a || !a.email) continue;
          out.push({
            kind: a.kind || (a.password ? 'imap' : 'google'),
            email: a.email,
            name: a.name || '',
            refreshToken: a.refreshToken,
            service: a.service,
            password: a.password,
            env: true,
          });
        }
      }
    } catch { /* malformed MAIL_ACCOUNTS — ignore */ }
  }
  if (process.env.GMAIL_REFRESH_TOKEN && !out.some(a => a.email === (process.env.GMAIL_EMAIL || ''))) {
    out.push({
      kind: 'google',
      email: process.env.GMAIL_EMAIL || 'Connected account',
      name: '',
      refreshToken: process.env.GMAIL_REFRESH_TOKEN,
      env: true,
    });
  }
  return out;
}

function cookieAccounts(req) {
  const cookies = parseCookies(req);
  if (!cookies[ACCOUNTS_COOKIE]) return [];
  try {
    return JSON.parse(Buffer.from(cookies[ACCOUNTS_COOKIE], 'base64').toString('utf8')) || [];
  } catch {
    return [];
  }
}

// accounts = [{ kind, email, name, refreshToken | password, service }]
// Env (hard-coded, global) accounts first, then any added on this device.
export function getAccounts(req) {
  const env = envAccounts();
  const seen = new Set(env.map(a => a.email));
  const extra = cookieAccounts(req).filter(a => a && a.email && !seen.has(a.email));
  return [...env, ...extra];
}

export function getActiveEmail(req) {
  const cookies = parseCookies(req);
  return cookies[ACTIVE_COOKIE] || null;
}

// Persist only the non-env accounts; env (hard-coded) accounts can't be changed.
export function saveAccounts(res, accounts) {
  const envEmails = new Set(envAccounts().map(a => a.email));
  const extra = (accounts || []).filter(a => a && a.email && !envEmails.has(a.email));
  const val = Buffer.from(JSON.stringify(extra)).toString('base64');
  appendCookies(res, [
    `${ACCOUNTS_COOKIE}=${val}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ONE_YEAR}`,
  ]);
}

export function setActive(res, email) {
  appendCookies(res, [
    `${ACTIVE_COOKIE}=${encodeURIComponent(email)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ONE_YEAR}`,
  ]);
}

export function clearAccountCookies(res) {
  appendCookies(res, [
    `${ACCOUNTS_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    `${ACTIVE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
  ]);
}

// Resolve which account/refresh-token the request should act as.
export function resolveAccount(req) {
  const accounts = getAccounts(req);
  if (!accounts.length) return null;
  const active = getActiveEmail(req);
  const found = accounts.find(a => a.email === active) || accounts[0];
  return { ...found, kind: found.kind || 'google' };
}

export async function getAccessToken(refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (data.error) {
    const err = new Error(data.error_description || data.error);
    err.code = 401;
    throw err;
  }
  return data.access_token;
}

export function gapi(accessToken, path, init = {}) {
  return fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, ...(init.headers || {}) },
  });
}
