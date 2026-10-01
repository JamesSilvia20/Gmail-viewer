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

// Model is overridable via env; defaults to the requested Flash-Lite model.
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

function clip(str, max = 4000) {
  str = String(str || '');
  return str.length > max ? str.slice(0, max) + '…' : str;
}

// Build the instruction + user prompt for each mode.
function buildPrompt({ mode, instruction, draft, to, subject, tone }) {
  const toneLine = tone ? `Write in a ${tone} tone.` : 'Use a natural, professional tone.';
  const ctx = [
    to ? `Recipient: ${clip(to, 200)}` : '',
    subject ? `Subject: ${clip(subject, 300)}` : '',
  ].filter(Boolean).join('\n');

  const rules =
    'You are an email writing assistant. Return ONLY the email body text — no subject line, ' +
    'no "Subject:", no greetings about being an AI, no markdown code fences, no commentary. ' +
    'Keep it well-structured and ready to send. ' + toneLine;

  if (mode === 'improve' || mode === 'rewrite') {
    return `${rules}\nRewrite and improve the following draft, fixing grammar and clarity while keeping the author's intent and any key facts.\n${ctx ? '\n' + ctx + '\n' : ''}\nDraft:\n"""\n${clip(draft)}\n"""`;
  }
  if (mode === 'reply') {
    return `${rules}\nWrite a reply email.${instruction ? ' Follow this guidance: ' + clip(instruction, 1000) : ''}\n${ctx ? '\n' + ctx + '\n' : ''}\nThe message being replied to / existing draft:\n"""\n${clip(draft)}\n"""`;
  }
  // compose (default)
  return `${rules}\nWrite a new email based on this request: ${clip(instruction, 1500)}\n${ctx ? '\n' + ctx : ''}`;
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

  const { mode = 'compose', instruction = '', draft = '', to = '', subject = '', tone = '' } = req.body || {};
  if (mode === 'compose' && !instruction.trim()) {
    return res.status(400).json({ error: 'Tell the assistant what to write.' });
  }
  if ((mode === 'improve' || mode === 'rewrite' || mode === 'reply') && !draft.trim() && !instruction.trim()) {
    return res.status(400).json({ error: 'Nothing to work with — write a draft or give an instruction first.' });
  }

  const prompt = buildPrompt({ mode, instruction, draft, to, subject, tone });

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent?key=${API_KEY}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, topP: 0.95, maxOutputTokens: 1024 },
      }),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = data?.error?.message || `Gemini request failed (${r.status})`;
      return res.status(r.status === 429 ? 429 : 502).json({ error: msg });
    }

    const cand = data.candidates?.[0];
    if (!cand || cand.finishReason === 'SAFETY') {
      return res.status(422).json({ error: 'The model declined to generate a response for this prompt.' });
    }
    const text = (cand.content?.parts || []).map(p => p.text || '').join('').trim();
    if (!text) return res.status(502).json({ error: 'Empty response from the model.' });

    return res.json({ text, model: MODEL });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'AI request failed.' });
  }
}
