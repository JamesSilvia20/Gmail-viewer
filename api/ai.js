// AI writing assistant backed by Google AI Studio (Gemini).
// The API key is read from Vercel environment variables. Several common
// names are accepted so it works regardless of what you called it.
const API_KEY =
  process.env.GOOGLE_AI_STUDIO_API_KEY ||
  process.env.GOOGLE_AI_API_KEY ||
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  '';

// Model is overridable via env (GEMINI_MODEL) without a code change.
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// What each action asks the model to do.
const TASKS = {
  write: 'Write a new email based on the request below.',
  reply: 'Write a reply to the original message below.',
  improve: "Improve the draft: fix grammar, spelling and clarity and tighten the wording, while keeping the author's meaning, facts and voice.",
  shorten: 'Make the draft noticeably shorter and more direct while keeping every key point.',
  expand: 'Expand the draft with helpful detail and smoother flow. Do not invent facts — use a short [placeholder] for anything unknown.',
  formal: 'Rewrite the draft in a more formal, professional tone.',
  friendly: 'Rewrite the draft in a warmer, friendlier tone.',
  proofread: 'Correct only spelling, grammar and punctuation. Change nothing else — keep the wording, structure and tone exactly.',
  custom: 'Rewrite the draft following the instruction below.',
  subject: 'Write a concise, specific subject line for this email.',
};
// Back-compat with the previous request shape ({ mode: 'compose' | 'improve' | 'rewrite' | 'reply' }).
const LEGACY = { compose: 'write', rewrite: 'improve' };
const DRAFT_ACTIONS = new Set(['improve', 'shorten', 'expand', 'formal', 'friendly', 'proofread', 'custom']);

function clip(str, max) {
  str = String(str || '').trim();
  return str.length > max ? str.slice(0, max) + '…' : str;
}

function systemPrompt({ action, senderName, hasSignature }) {
  if (action === 'subject') {
    return 'You write email subject lines. Return ONLY the subject line: at most 9 words, no quotation marks, ' +
      'no "Subject:" prefix, no trailing period. Match the language of the email.';
  }
  const closing = hasSignature
    ? 'Do not add a sign-off name or signature — the app appends the sender\'s signature automatically. A short closing such as "Best," is fine.'
    : `End with a short closing${senderName ? ` and the sender's first name (${senderName.split(/\s+/)[0]})` : ''}. Never write placeholders like [Your Name].`;
  return [
    'You are an expert email writing assistant built into a mail app.',
    'Return ONLY the email body as plain text, ready to send: no subject line, no markdown, no code fences, ' +
      'no commentary or explanations, no quotation marks around the whole text.',
    'Separate paragraphs with a blank line. Keep it natural and human; avoid filler, clichés and over-formality unless asked.',
    'Never invent facts, dates, numbers, names, links or commitments. If something essential is unknown, use a short [placeholder] in square brackets.',
    'Do not repeat or quote the original message.',
    'Write in the same language as the draft or the original message unless the instruction says otherwise.',
    closing,
  ].join('\n');
}

function userPrompt(p) {
  const parts = [`Task: ${TASKS[p.action]}`];
  if (p.tone && !['formal', 'friendly', 'proofread'].includes(p.action)) parts.push(`Tone: ${clip(p.tone, 40)}.`);
  if (p.instruction) parts.push(`Instruction: ${clip(p.instruction, 1500)}`);
  const ctx = [
    p.senderName || p.senderEmail ? `Sender (me): ${[p.senderName, p.senderEmail && `<${p.senderEmail}>`].filter(Boolean).join(' ')}` : '',
    p.to ? `Recipients: ${clip(p.to, 300)}` : '',
    p.subject ? `Subject: ${clip(p.subject, 300)}` : '',
  ].filter(Boolean);
  if (ctx.length) parts.push(ctx.join('\n'));
  const o = p.original;
  if (o && (o.text || o.subject)) {
    parts.push([
      'Original message:',
      o.from ? `From: ${clip(o.from, 200)}` : '',
      o.date ? `Date: ${clip(o.date, 80)}` : '',
      o.subject ? `Subject: ${clip(o.subject, 300)}` : '',
      '"""',
      clip(o.text, 6000),
      '"""',
    ].filter(Boolean).join('\n'));
  }
  if (p.draft) parts.push(`${p.action === 'subject' ? 'Email' : 'Current draft'}:\n"""\n${clip(p.draft, 8000)}\n"""`);
  return parts.join('\n\n');
}

function geminiBody(p) {
  return JSON.stringify({
    systemInstruction: { parts: [{ text: systemPrompt(p) }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt(p) }] }],
    generationConfig: {
      temperature: p.action === 'proofread' ? 0.2 : p.action === 'subject' ? 0.5 : 0.7,
      topP: 0.95,
      maxOutputTokens: p.action === 'subject' ? 256 : 2048,
    },
  });
}

function textOf(data) {
  return (data?.candidates?.[0]?.content?.parts || []).map(x => x.text || '').join('');
}
function blockedReason(data) {
  if (data?.promptFeedback?.blockReason) return 'The request was blocked by the model’s safety filters.';
  if (data?.candidates?.[0]?.finishReason === 'SAFETY') return 'The model declined to write this.';
  return null;
}

// Strip wrappers models sometimes add despite instructions.
function cleanText(t, action) {
  let s = String(t || '').replace(/\r\n/g, '\n').trim();
  s = s.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim();
  if (action === 'subject') {
    return s.split('\n')[0].replace(/^subject:\s*/i, '').replace(/^["“']|["”']$/g, '').replace(/\.$/, '').trim();
  }
  return s.replace(/^subject:[^\n]*\n+/i, '').trim();
}

async function generate(p) {
  const r = await fetch(`${BASE}/${encodeURIComponent(MODEL)}:generateContent?key=${API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: geminiBody(p),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(data?.error?.message || `Gemini request failed (${r.status})`);
    e.status = r.status === 429 ? 429 : 502;
    throw e;
  }
  const blocked = blockedReason(data);
  if (blocked) { const e = new Error(blocked); e.status = 422; throw e; }
  const text = cleanText(textOf(data), p.action);
  if (!text) { const e = new Error('The model returned an empty response. Try again.'); e.status = 502; throw e; }
  return text;
}

// Streams newline-delimited JSON to the client: {"t":"chunk"} … {"done":true,"model":"…"}.
// Falls back to a single non-streamed call if Gemini's stream can't be opened.
async function stream(p, res) {
  let upstream;
  try {
    upstream = await fetch(`${BASE}/${encodeURIComponent(MODEL)}:streamGenerateContent?alt=sse&key=${API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: geminiBody(p),
    });
  } catch { upstream = null; }

  if (!upstream || !upstream.ok || !upstream.body) {
    // Surface real API errors (bad key, unknown model, quota); otherwise try non-streaming.
    if (upstream && !upstream.ok) {
      const data = await upstream.json().catch(() => ({}));
      return res.status(upstream.status === 429 ? 429 : 502)
        .json({ error: data?.error?.message || `Gemini request failed (${upstream.status})` });
    }
    const text = await generate(p);
    return res.json({ text, model: MODEL });
  }

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  });
  const send = obj => res.write(JSON.stringify(obj) + '\n');
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', any = false, failed = null;
  const handleLine = line => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let data;
    try { data = JSON.parse(payload); } catch { return; }
    const blocked = blockedReason(data);
    if (blocked) { failed = blocked; return; }
    const t = textOf(data);
    if (t) { any = true; send({ t }); }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) > -1) {
        handleLine(buf.slice(0, nl).replace(/\r$/, ''));
        buf = buf.slice(nl + 1);
      }
    }
    if (buf) handleLine(buf.replace(/\r$/, ''));
  } catch (e) {
    failed = failed || e.message || 'The AI stream was interrupted.';
  }
  if (failed) send({ error: failed });
  else if (!any) send({ error: 'The model returned an empty response. Try again.' });
  else send({ done: true, model: MODEL });
  res.end();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  if (!API_KEY) {
    return res.status(500).json({
      error: 'AI is not configured. Set GEMINI_API_KEY (or GOOGLE_AI_STUDIO_API_KEY) in your Vercel environment variables.',
    });
  }

  const b = req.body || {};
  const requested = String(b.action || b.mode || 'write');
  const action = LEGACY[requested] || requested;
  if (!TASKS[action]) return res.status(400).json({ error: `Unknown action "${requested}".` });

  const original = b.original && typeof b.original === 'object'
    ? { from: String(b.original.from || ''), date: String(b.original.date || ''), subject: String(b.original.subject || ''), text: String(b.original.text || '') }
    : null;
  const p = {
    action,
    instruction: String(b.instruction || '').trim(),
    draft: String(b.draft || '').trim(),
    tone: String(b.tone || '').trim(),
    to: String(b.to || '').trim(),
    subject: String(b.subject || '').trim(),
    senderName: String(b.senderName || '').trim(),
    senderEmail: String(b.senderEmail || '').trim(),
    hasSignature: !!b.hasSignature,
    original,
  };

  // Old clients sent the quoted reply inside `draft`; treat it as context.
  if (action === 'reply' && !p.original && p.draft) { p.original = { text: p.draft }; p.draft = ''; }

  if (action === 'write' && !p.instruction) return res.status(400).json({ error: 'Tell the assistant what to write.' });
  if (action === 'reply' && !p.original?.text && !p.instruction) return res.status(400).json({ error: 'There’s no message to reply to.' });
  if (action === 'custom' && !p.instruction) return res.status(400).json({ error: 'Tell the assistant how to change the draft.' });
  if (DRAFT_ACTIONS.has(action) && !p.draft) return res.status(400).json({ error: 'Write a draft first, then ask the assistant to change it.' });
  if (action === 'subject' && !p.draft && !p.original?.text && !p.instruction) return res.status(400).json({ error: 'Write the email first, then suggest a subject.' });

  try {
    if (b.stream) return await stream(p, res);
    const text = await generate(p);
    return res.json({ text, model: MODEL });
  } catch (e) {
    if (res.headersSent) { try { res.end(); } catch {} return; }
    return res.status(e.status || 500).json({ error: e.message || 'AI request failed.' });
  }
}
