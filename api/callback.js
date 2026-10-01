import { getAccounts, saveAccounts, setActive } from './_google.js';

function errorPage(res, title, detail) {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html><html><body style="font-family:system-ui,monospace;background:#08090e;color:#e2e8f8;padding:40px;max-width:600px;margin:0 auto;">
    <h2 style="color:#f87171">${title}</h2><p style="color:#7a90b8">${detail || ''}</p>
    <p><a href="/" style="color:#5b8aff">← Back to inbox</a></p>
  </body></html>`);
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// One-time setup page: shows the refresh token + a ready-to-paste MAIL_ACCOUNTS entry.
function tokenPage(res, email, name, refreshToken) {
  const entry = JSON.stringify({ kind: 'google', email, name, refreshToken });
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Refresh token</title></head>
  <body style="font-family:system-ui,sans-serif;background:#0A0A0F;color:#ECECF4;padding:40px;max-width:760px;margin:0 auto;line-height:1.6">
    <h2 style="font-weight:800;letter-spacing:-.02em;background:linear-gradient(135deg,#6366F1,#D946EF);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;display:inline-block">Refresh token for ${escHtml(email)}</h2>
    <p style="color:#9A9AB0">Add this account to <code style="color:#A78BFA">MAIL_ACCOUNTS</code> in your Vercel environment variables. It will then appear on every device with no storage. Keep this token secret.</p>
    <p style="color:#9A9AB0;margin-top:18px;font-weight:600">Ready-to-paste entry (one element of the JSON array):</p>
    <textarea readonly onclick="this.select()" style="width:100%;min-height:120px;background:#16161F;color:#ECECF4;border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:14px;font-family:ui-monospace,monospace;font-size:13px;resize:vertical">${escHtml(entry)}</textarea>
    <p style="color:#5E5E76;font-size:13px;margin-top:10px">Raw refresh token:</p>
    <textarea readonly onclick="this.select()" style="width:100%;min-height:60px;background:#16161F;color:#9A9AB0;border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:12px;font-family:ui-monospace,monospace;font-size:12px">${escHtml(refreshToken)}</textarea>
    <p style="margin-top:24px"><a href="/" style="color:#A78BFA;text-decoration:none;font-weight:600">← Back to inbox</a></p>
  </body></html>`);
}

export default async function handler(req, res) {
  const { code, error } = req.query;

  if (error) return errorPage(res, 'Authorization Error', error);
  if (!code) return errorPage(res, 'No authorization code received');

  const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
  const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
  const REDIRECT_URI = `https://${req.headers.host}/auth/callback`;

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });

    const data = await tokenRes.json();
    if (data.error) return errorPage(res, 'Token Error', `${data.error}: ${data.error_description || ''}`);

    const refreshToken = data.refresh_token;
    if (!refreshToken) {
      return errorPage(res, 'No refresh token', 'Google did not return a refresh token. Remove the app from your Google account permissions and try again.');
    }

    // Identify which account this is.
    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${data.access_token}` },
    });
    const profile = await profileRes.json();
    const email = profile.email || '';
    const name = profile.name || '';

    // One-time setup helper: show the refresh token to hard-code, don't save.
    if (req.query.state === 'showtoken') return tokenPage(res, email, name, refreshToken);

    const accounts = await getAccounts(req);
    const idx = accounts.findIndex(a => a.email === email);
    const entry = { kind: 'google', email, name, refreshToken };
    if (idx > -1) accounts[idx] = entry;
    else accounts.push(entry);

    await saveAccounts(res, accounts);
    await setActive(res, email);

    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=/"></head>
      <body style="font-family:system-ui;background:#08090e;color:#e2e8f8;padding:40px;text-align:center;">
      <p>Signed in as ${email}. Redirecting…</p>
      <script>location.replace('/');</script></body></html>`);
  } catch (e) {
    return errorPage(res, 'Error', e.message);
  }
}
