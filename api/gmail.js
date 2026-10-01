import {
  resolveAccount, getAccounts, getActiveEmail, getAccessToken, gapi,
  saveAccounts, setActive, clearAccountCookies,
} from './_google.js';
import {
  imapList, imapMessage, imapModify, imapTrash, imapUntrash, imapDelete, imapSend,
} from './_imap.js';

async function handleImap(req, res, account, action, query, body) {
  try {
    if (action === 'userinfo') return res.json({ email: account.email, name: account.name });
    if (action === 'labels') return res.json({ labels: [] });
    if (action === 'message' && (query.id || body.id)) {
      return res.json(await imapMessage(account, query.id || body.id));
    }
    if (req.method === 'POST') {
      if (action === 'send') return res.json(await imapSend(account, body));
      if (action === 'trash') return res.json(await imapTrash(account, body.id));
      if (action === 'untrash') return res.json(await imapUntrash(account, body.id));
      if (action === 'delete') return res.json(await imapDelete(account, body.id));
      if (action === 'modify') return res.json(await imapModify(account, body));
    }
    const folder = query.label && query.label !== 'SEARCH' ? query.label : (query.q ? 'SEARCH' : 'ALL');
    return res.json(await imapList(account, { folder, q: query.q, pageToken: query.pageToken }));
  } catch (e) {
    const msg = e.message || String(e);
    const authFail = !!e.authenticationFailed || /auth|login|credential|invalid|denied/i.test(msg);
    return res.status(authFail ? 401 : 500).json({ error: msg, needReconnect: authFail });
  }
}

function mimeWord(str) {
  // Encode a header value as a MIME encoded-word if it contains non-ASCII.
  if (/^[\x00-\x7F]*$/.test(str)) return str;
  return `=?UTF-8?B?${Buffer.from(str, 'utf8').toString('base64')}?=`;
}

function buildRaw({ to, cc, bcc, from, subject, body, inReplyTo, references }) {
  const lines = [];
  if (from) lines.push(`From: ${from}`);
  lines.push(`To: ${to}`);
  if (cc) lines.push(`Cc: ${cc}`);
  if (bcc) lines.push(`Bcc: ${bcc}`);
  lines.push(`Subject: ${mimeWord(subject || '')}`);
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) lines.push(`References: ${references}`);
  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push('Content-Transfer-Encoding: 7bit');
  lines.push('');
  lines.push(body || '');
  const raw = lines.join('\r\n');
  return Buffer.from(raw, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const query = req.query || {};
  const body = req.method === 'POST' ? (req.body || {}) : {};
  const action = query.action || body.action;

  // ── Account management actions (no Gmail call needed) ──
  if (action === 'accounts') {
    const accounts = await getAccounts(req);
    const env = !accounts.length && process.env.GMAIL_REFRESH_TOKEN ? [{ email: process.env.GMAIL_EMAIL || 'Connected account', name: '', kind: 'google', env: true }] : [];
    const list = accounts.length ? accounts.map(a => ({ email: a.email, name: a.name, kind: a.kind || 'google', service: a.service, env: !!a.env })) : env;
    return res.json({ accounts: list, active: (await getActiveEmail(req)) || (list[0] && list[0].email) || null });
  }

  if (action === 'switch') {
    await setActive(res, body.email || query.email);
    return res.json({ ok: true });
  }

  if (action === 'signout') {
    const target = body.email || query.email;
    let accounts = await getAccounts(req);
    if (target) {
      accounts = accounts.filter(a => a.email !== target);
      await saveAccounts(res, accounts);
      if ((await getActiveEmail(req)) === target) await setActive(res, accounts[0]?.email || '');
    } else {
      await clearAccountCookies(res);
    }
    return res.json({ ok: true, accounts: accounts.map(a => ({ email: a.email, name: a.name })) });
  }

  // ── Everything else needs an authenticated account ──
  let account = await resolveAccount(req);
  // Compose can send from any connected account, not just the active one.
  if (req.method === 'POST' && action === 'send' && body.account) {
    const pick = (await getAccounts(req)).find(a => a.email === body.account);
    if (pick) account = { ...pick, kind: pick.kind || 'google' };
  }
  if (!account) return res.status(401).json({ error: 'Not signed in', needAuth: true });

  // Non-Gmail providers (iCloud, AOL, Yahoo) go through IMAP/SMTP.
  if (account.kind === 'imap') return handleImap(req, res, account, action, query, body);

  let accessToken;
  try {
    accessToken = await getAccessToken(account.refreshToken);
  } catch (e) {
    return res.status(401).json({ error: `Auth failed: ${e.message}`, needAuth: true });
  }

  try {
    // ── GET reads ──
    if (action === 'userinfo') {
      return res.json({ email: account.email, name: account.name });
    }

    if (action === 'labels') {
      const r = await gapi(accessToken, 'labels');
      return res.json(await r.json());
    }

    if (action === 'message' && (query.id || body.id)) {
      const r = await gapi(accessToken, `messages/${query.id || body.id}?format=full`);
      return res.json(await r.json());
    }

    // ── POST mutations ──
    if (req.method === 'POST') {
      // Helper: surface Google scope errors as a re-auth prompt.
      const checkErr = (data) => {
        const msg = data?.error?.message || '';
        if (/insufficient.*scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(msg)) {
          res.status(403).json({
            error: 'This account is signed in with read-only access. Sign in with Google again to enable sending and managing mail.',
            needScope: true,
          });
          return true;
        }
        if (data?.error) { res.status(400).json({ error: msg }); return true; }
        return false;
      };

      if (action === 'send') {
        const raw = buildRaw({ ...body, from: account.email });
        const payload = { raw };
        if (body.threadId) payload.threadId = body.threadId;
        const r = await gapi(accessToken, 'messages/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await r.json();
        if (checkErr(data)) return;
        return res.json(data);
      }

      if (action === 'trash') {
        const r = await gapi(accessToken, `messages/${body.id}/trash`, { method: 'POST' });
        const data = await r.json();
        if (checkErr(data)) return;
        return res.json(data);
      }

      if (action === 'untrash') {
        const r = await gapi(accessToken, `messages/${body.id}/untrash`, { method: 'POST' });
        const data = await r.json();
        if (checkErr(data)) return;
        return res.json(data);
      }

      if (action === 'delete') {
        const r = await gapi(accessToken, `messages/${body.id}`, { method: 'DELETE' });
        if (r.status === 204) return res.json({ ok: true });
        const data = await r.json().catch(() => ({}));
        if (checkErr(data)) return;
        return res.json(data.error ? data : { ok: true });
      }

      if (action === 'modify') {
        const r = await gapi(accessToken, `messages/${body.id}/modify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            addLabelIds: body.addLabelIds || [],
            removeLabelIds: body.removeLabelIds || [],
          }),
        });
        const data = await r.json();
        if (checkErr(data)) return;
        return res.json(data);
      }
    }

    // ── Default: list messages (supports label + search) ──
    const maxResults = query.maxResults || 50;
    const params = new URLSearchParams({ maxResults: String(maxResults) });
    const label = query.label || 'INBOX';
    if (label && label !== 'SEARCH') params.append('labelIds', label);
    if (query.q) params.set('q', query.q);
    if (query.pageToken) params.set('pageToken', query.pageToken);

    const listRes = await gapi(accessToken, `messages?${params}`);
    const listData = await listRes.json();
    if (listData.error) return res.status(400).json({ error: listData.error.message });
    if (!listData.messages) return res.json({ messages: [], nextPageToken: null });

    const details = await Promise.all(
      listData.messages.map(m =>
        gapi(accessToken, `messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`)
          .then(r => r.json())
      )
    );

    const emails = details.map(msg => {
      const headers = msg.payload?.headers || [];
      const get = n => headers.find(h => h.name.toLowerCase() === n.toLowerCase())?.value || '';
      const labels = msg.labelIds || [];
      return {
        id: msg.id,
        threadId: msg.threadId,
        subject: get('Subject') || '(no subject)',
        from: get('From'),
        to: get('To'),
        date: get('Date'),
        snippet: msg.snippet || '',
        unread: labels.includes('UNREAD'),
        starred: labels.includes('STARRED'),
        labelIds: labels,
      };
    });

    return res.json({ messages: emails, nextPageToken: listData.nextPageToken || null });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
