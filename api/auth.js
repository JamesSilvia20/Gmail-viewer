import { OAUTH_SCOPES } from './_google.js';

export default function handler(req, res) {
  const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
  const REDIRECT_URI = `https://${req.headers.host}/auth/callback`;

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: OAUTH_SCOPES,
    access_type: 'offline',
    prompt: 'consent select_account',
  });

  // ?show=1 → after sign-in, display the refresh token for hard-coding into
  // MAIL_ACCOUNTS instead of saving the account. (one-time setup helper)
  if (req.query && (req.query.show || req.query.token)) params.append('state', 'showtoken');

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}
