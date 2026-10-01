import { getAccounts, saveAccounts, setActive } from './_google.js';
import { imapVerify, IMAP_PRESETS } from './_imap.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { service, email, password, name } = req.body || {};
  if (!IMAP_PRESETS[service]) return res.status(400).json({ error: 'Unknown provider' });
  if (!email || !password) return res.status(400).json({ error: 'Email and app password are required' });

  try {
    await imapVerify({ service, email, password });
  } catch (e) {
    return res.status(401).json({
      error: `Sign-in failed. Use an app-specific password for ${IMAP_PRESETS[service].label}. (${e.message})`,
    });
  }

  const accounts = await getAccounts(req);
  const entry = { kind: 'imap', service, email, name: name || '', password };
  const idx = accounts.findIndex(a => a.email === email);
  if (idx > -1) accounts[idx] = entry;
  else accounts.push(entry);

  await saveAccounts(res, accounts);
  await setActive(res, email);
  return res.json({ ok: true, email });
}
