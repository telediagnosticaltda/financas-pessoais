// api/gmail-sync.js
// Busca e-mails no Gmail e retorna os PDFs brutos para o BROWSER processar
// O browser já sabe descriptografar PDFs com senha (PDF.js) — sem worker issues

export const config = { api: { bodyParser: true } };

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_KEY;

const sbH = {
  'apikey':        SB_KEY,
  'Authorization': `Bearer ${SB_KEY}`,
  'Content-Type':  'application/json'
};

async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sbH });
  return r.json();
}

async function getAccessToken() {
  const [token] = await sbGet('app_tokens?key=eq.gmail_refresh_token&select=value');
  if (!token) throw new Error('Gmail não autorizado. Acesse /api/gmail-auth primeiro.');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token:  token.value,
      client_id:      process.env.GOOGLE_CLIENT_ID,
      client_secret:  process.env.GOOGLE_CLIENT_SECRET,
      grant_type:     'refresh_token'
    })
  });
  const data = await r.json();
  if (!data.access_token) throw new Error('Falha ao renovar token do Gmail');
  return data.access_token;
}

async function searchMessages(accessToken, query, max = 10) {
  const r = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${max}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await r.json();
  return data.messages || [];
}

async function getMessage(accessToken, id) {
  const r = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  return r.json();
}

async function getAttachment(accessToken, msgId, attId) {
  const r = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}/attachments/${attId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await r.json();
  return (data.data || '').replace(/-/g, '+').replace(/_/g, '/');
}

function extractEmailBody(payload) {
  if (!payload) return '';
  if (payload.body?.data) {
    return Buffer.from(payload.body.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const t = extractEmailBody(part);
      if (t) return t;
    }
  }
  return '';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const log = [];

  try {
    const accessToken = await getAccessToken();
    const days = req.body?.days || 50;

    const [cpfToken] = await sbGet('app_tokens?key=eq.user_cpf&select=value');
    const cpf = cpfToken?.value || '';
    log.push(cpf ? `✓ CPF configurado (${cpf.length} dígitos)` : '⚠ CPF não configurado');
    log.push(`✓ Gmail autorizado — buscando últimos ${days} dias`);

    const pdfs = [];
    const emailTexts = [];

    // ── BTG/EQI ────────────────────────────────────────────────
    const btgMsgs = await searchMessages(accessToken,
      `(filename:EQI OR filename:BTG) filename:Fatura has:attachment newer_than:${days}d`, 5);
    log.push(`Encontrados ${btgMsgs.length} e-mail(s) BTG/EQI`);

    for (const { id: msgId } of btgMsgs.slice(0, 1)) {
      const msg  = await getMessage(accessToken, msgId);
      const date = new Date(parseInt(msg.internalDate)).toISOString().slice(0, 10);
      const pdfPart = (msg.payload?.parts || []).find(p =>
        p.mimeType === 'application/pdf' || (p.filename || '').toLowerCase().endsWith('.pdf')
      );
      if (!pdfPart?.body?.attachmentId) continue;
      const b64 = await getAttachment(accessToken, msgId, pdfPart.body.attachmentId);
      pdfs.push({ msgId, bank: 'btg', filename: pdfPart.filename, date, base64: b64, password: cpf });
      log.push(`✓ BTG/EQI: ${pdfPart.filename} (${date})`);
    }

    // ── XP ─────────────────────────────────────────────────────
    const xpMsgs = await searchMessages(accessToken,
      `filename:XP has:attachment newer_than:${days}d`, 5);
    log.push(`Encontrados ${xpMsgs.length} e-mail(s) XP`);

    for (const { id: msgId } of xpMsgs.slice(0, 1)) {
      const msg  = await getMessage(accessToken, msgId);
      const date = new Date(parseInt(msg.internalDate)).toISOString().slice(0, 10);
      const pdfPart = (msg.payload?.parts || []).find(p =>
        p.mimeType === 'application/pdf' || (p.filename || '').toLowerCase().endsWith('.pdf')
      );
      if (!pdfPart?.body?.attachmentId) continue;
      const b64 = await getAttachment(accessToken, msgId, pdfPart.body.attachmentId);
      pdfs.push({ msgId, bank: 'xp', filename: pdfPart.filename, date, base64: b64, password: cpf.slice(0, 5) });
      log.push(`✓ XP: ${pdfPart.filename} (${date})`);
    }

    // ── Nubank ─────────────────────────────────────────────────
    const nubankMsgs = await searchMessages(accessToken,
      `from:nubank.com.br newer_than:${Math.max(days, 2)}d`, 10);
    log.push(`Encontrados ${nubankMsgs.length} e-mail(s) Nubank`);

    for (const { id: msgId } of nubankMsgs.slice(0, 2)) {
      const msg  = await getMessage(accessToken, msgId);
      const date = new Date(parseInt(msg.internalDate)).toISOString().slice(0, 10);
      const pdfPart = (msg.payload?.parts || []).find(p =>
        p.mimeType === 'application/pdf' || (p.filename || '').toLowerCase().endsWith('.pdf')
      );
      if (pdfPart?.body?.attachmentId) {
        const b64 = await getAttachment(accessToken, msgId, pdfPart.body.attachmentId);
        pdfs.push({ msgId, bank: 'nubank', filename: pdfPart.filename, date, base64: b64, password: '' });
        log.push(`✓ Nubank PDF: ${pdfPart.filename} (${date})`);
      } else {
        const body = extractEmailBody(msg.payload);
        if (body) emailTexts.push({ msgId, bank: 'nubank', date, text: body });
      }
    }

    if (!pdfs.length && !emailTexts.length) log.push('Nenhum novo arquivo encontrado');

    return res.status(200).json({ success: true, pdfs, emailTexts, log });

  } catch (err) {
    console.error('[gmail-sync]', err);
    return res.status(500).json({ success: false, error: err.message, log });
  }
}
