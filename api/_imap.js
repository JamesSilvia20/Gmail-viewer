// IMAP/SMTP backend for non-Gmail providers (iCloud, AOL, Yahoo, generic).
// Results are shaped to mirror the Gmail REST API so the frontend renderer
// works unchanged across providers.
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';

export const IMAP_PRESETS = {
  gmail: {
    label: 'Gmail / Google Workspace',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
  },
  icloud: {
    label: 'iCloud',
    imap: { host: 'imap.mail.me.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false },
  },
  aol: {
    label: 'AOL',
    imap: { host: 'imap.aol.com', port: 993, secure: true },
    smtp: { host: 'smtp.aol.com', port: 465, secure: true },
  },
  yahoo: {
    label: 'Yahoo',
    imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
  },
};

function preset(service) {
  return IMAP_PRESETS[service] || IMAP_PRESETS.icloud;
}

async function connect(account) {
  const p = preset(account.service);
  const client = new ImapFlow({
    host: p.imap.host,
    port: p.imap.port,
    secure: p.imap.secure,
    auth: { user: account.email, pass: account.password },
    logger: false,
  });
  await client.connect();
  return client;
}

function splitId(id) {
  const i = id.indexOf(':');
  return [id.slice(0, i), parseInt(id.slice(i + 1), 10)];
}

function fmtAddr(arr) {
  if (!arr || !arr.length) return '';
  return arr.map(a => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ');
}

function b64url(str) {
  return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

// Map our logical folder ids to actual mailbox paths for this account.
async function resolveMailboxes(client) {
  const list = await client.list();
  const bySpecial = {};
  for (const mb of list) if (mb.specialUse) bySpecial[mb.specialUse] = mb.path;
  const byName = names => (list.find(m => names.some(n => m.path.toLowerCase() === n.toLowerCase())) || {}).path;
  const find = (special, names) => bySpecial[special] || byName(names);
  return {
    INBOX: 'INBOX',
    SENT: find('\\Sent', ['Sent', 'Sent Messages', 'Sent Items']),
    DRAFT: find('\\Drafts', ['Drafts']),
    SPAM: find('\\Junk', ['Junk', 'Spam', 'Bulk Mail']),
    TRASH: find('\\Trash', ['Trash', 'Deleted Messages', 'Deleted']),
    ARCHIVE: find('\\Archive', ['Archive']),
    ALL: bySpecial['\\All'] || 'INBOX',
  };
}

function pathFor(map, folder) {
  if (folder === 'STARRED' || folder === 'SEARCH') return 'INBOX';
  return map[folder] || 'INBOX';
}

export async function imapList(account, { folder = 'INBOX', q, pageToken }) {
  const client = await connect(account);
  try {
    const map = await resolveMailboxes(client);
    const path = pathFor(map, folder);
    const lock = await client.getMailboxLock(path);
    try {
      let uids;
      if (q) uids = await client.search({ text: q }, { uid: true });
      else if (folder === 'STARRED') uids = await client.search({ flagged: true }, { uid: true });
      else uids = await client.search({ all: true }, { uid: true });
      uids = (uids || []).sort((a, b) => b - a);

      const offset = pageToken ? parseInt(pageToken, 10) : 0;
      const pageSize = 40;
      const slice = uids.slice(offset, offset + pageSize);

      const messages = [];
      if (slice.length) {
        for await (const msg of client.fetch(slice.join(','), { uid: true, envelope: true, flags: true, internalDate: true }, { uid: true })) {
          const env = msg.envelope || {};
          const date = env.date instanceof Date ? env.date.toISOString() : String(env.date || msg.internalDate || '');
          messages.push({
            id: `${folder}:${msg.uid}`,
            threadId: `${folder}:${msg.uid}`,
            subject: env.subject || '(no subject)',
            from: fmtAddr(env.from),
            to: fmtAddr(env.to),
            date,
            snippet: '',
            unread: !msg.flags.has('\\Seen'),
            starred: msg.flags.has('\\Flagged'),
            labelIds: [],
          });
        }
      }
      messages.sort((a, b) => Number(b.id.split(':')[1]) - Number(a.id.split(':')[1]));
      const next = offset + pageSize < uids.length ? String(offset + pageSize) : null;
      return { messages, nextPageToken: next };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function imapMessage(account, id) {
  const [folder, uid] = splitId(id);
  const client = await connect(account);
  try {
    const map = await resolveMailboxes(client);
    const lock = await client.getMailboxLock(pathFor(map, folder));
    try {
      const msg = await client.fetchOne(String(uid), { uid: true, source: true, flags: true }, { uid: true });
      if (!msg) throw new Error('Message not found');
      const parsed = await simpleParser(msg.source);

      const headers = [];
      const push = (n, v) => { if (v) headers.push({ name: n, value: v }); };
      push('Subject', parsed.subject || '');
      push('From', parsed.from?.text || '');
      push('To', parsed.to?.text || '');
      push('Cc', parsed.cc?.text || '');
      push('Date', parsed.date ? parsed.date.toUTCString() : '');
      push('Message-ID', parsed.messageId || '');
      push('References', [].concat(parsed.references || []).join(' '));

      const html = parsed.html || '';
      const text = parsed.text || '';
      const payload = { headers, mimeType: html ? 'text/html' : 'text/plain', parts: [] };
      if (html) payload.parts.push({ mimeType: 'text/html', body: { data: b64url(html) } });
      if (text) payload.parts.push({ mimeType: 'text/plain', body: { data: b64url(text) } });

      const flags = msg.flags || new Set();
      const labelIds = [];
      if (!flags.has('\\Seen')) labelIds.push('UNREAD');
      if (flags.has('\\Flagged')) labelIds.push('STARRED');
      if (folder === 'TRASH') labelIds.push('TRASH');
      if (folder === 'SPAM') labelIds.push('SPAM');

      return { id, threadId: id, snippet: (text || '').replace(/\s+/g, ' ').slice(0, 200), labelIds, payload };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function imapModify(account, { id, addLabelIds = [], removeLabelIds = [] }) {
  const [folder, uid] = splitId(id);
  const u = String(uid);
  const client = await connect(account);
  try {
    const map = await resolveMailboxes(client);
    const lock = await client.getMailboxLock(pathFor(map, folder));
    try {
      if (addLabelIds.includes('UNREAD')) await client.messageFlagsRemove(u, ['\\Seen'], { uid: true });
      if (removeLabelIds.includes('UNREAD')) await client.messageFlagsAdd(u, ['\\Seen'], { uid: true });
      if (addLabelIds.includes('STARRED')) await client.messageFlagsAdd(u, ['\\Flagged'], { uid: true });
      if (removeLabelIds.includes('STARRED')) await client.messageFlagsRemove(u, ['\\Flagged'], { uid: true });

      if (addLabelIds.includes('SPAM') && map.SPAM) {
        await client.messageMove(u, map.SPAM, { uid: true });
      } else if (removeLabelIds.includes('SPAM')) {
        await client.messageMove(u, 'INBOX', { uid: true });
      } else if (removeLabelIds.includes('INBOX') && map.ARCHIVE) {
        await client.messageMove(u, map.ARCHIVE, { uid: true });
      }
      return { ok: true };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

async function moveOrDelete(account, id, dest) {
  const [folder, uid] = splitId(id);
  const u = String(uid);
  const client = await connect(account);
  try {
    const map = await resolveMailboxes(client);
    const lock = await client.getMailboxLock(pathFor(map, folder));
    try {
      const target = dest === 'TRASH' ? map.TRASH : dest === 'INBOX' ? 'INBOX' : null;
      if (dest === 'EXPUNGE' || !target || target === pathFor(map, folder)) {
        await client.messageDelete(u, { uid: true });
      } else {
        await client.messageMove(u, target, { uid: true });
      }
      return { ok: true };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

export const imapTrash = (account, id) => moveOrDelete(account, id, 'TRASH');
export const imapUntrash = (account, id) => moveOrDelete(account, id, 'INBOX');
export const imapDelete = (account, id) => moveOrDelete(account, id, 'EXPUNGE');

export async function imapSend(account, { to, cc, bcc, subject, body, inReplyTo, references }) {
  const p = preset(account.service);
  const transporter = nodemailer.createTransport({
    host: p.smtp.host,
    port: p.smtp.port,
    secure: p.smtp.secure,
    auth: { user: account.email, pass: account.password },
  });
  const from = account.name ? `${account.name} <${account.email}>` : account.email;
  const info = await transporter.sendMail({
    from, to, cc, bcc, subject, text: body,
    inReplyTo: inReplyTo || undefined,
    references: references || undefined,
  });

  // Best-effort: save a copy to the Sent mailbox (most SMTP servers won't).
  try {
    const client = await connect(account);
    try {
      const map = await resolveMailboxes(client);
      if (map.SENT && info.message) {
        await client.append(map.SENT, info.message, ['\\Seen']);
      }
    } finally {
      await client.logout().catch(() => {});
    }
  } catch {}

  return { id: info.messageId };
}

// Validate credentials by attempting a login; resolves the display profile.
export async function imapVerify({ service, email, password }) {
  const client = await connect({ service, email, password });
  await client.logout().catch(() => {});
  return { email, service };
}
