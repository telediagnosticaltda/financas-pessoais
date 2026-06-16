// api/cron-sync.js — Roda às 9h pelo Vercel cron
// Busca e-mails no Gmail e enfileira PDFs para o browser processar
// Notificações do Nubank são parseadas aqui mesmo (regex, sem PDF)

export const config = { api: { bodyParser: false } };

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_KEY;

const sbH = {
  'apikey': SB_KEY,
  'Authorization': `Bearer ${SB_KEY}`,
  'Content-Type': 'application/json'
};

async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sbH });
  return r.json();
}

async function sbPost(table, body, prefer = '') {
  return fetch(`${SB_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...sbH, ...(prefer ? { 'Prefer': prefer } : {}) },
    body: JSON.stringify(body)
  });
}

async function getAccessToken() {
  const [token] = await sbGet('app_tokens?key=eq.gmail_refresh_token&select=value');
  if (!token) throw new Error('Gmail não autorizado');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: token.value,
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type:    'refresh_token'
    })
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('Falha ao renovar token Gmail');
  return d.access_token;
}

async function searchMessages(token, query, max = 20) {
  const r = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${max}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const d = await r.json();
  return d.messages || [];
}

async function getMessage(token, id) {
  const r = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return r.json();
}

function findPDFPart(payload) {
  if (!payload) return null;
  if ((payload.mimeType === 'application/pdf' || (payload.filename || '').toLowerCase().endsWith('.pdf')) && payload.body?.attachmentId) return payload;
  if (payload.parts) { for (const p of payload.parts) { const f = findPDFPart(p); if (f) return f; } }
  return null;
}

// Regex parser para notificações do Nubank (sem PDF)
function parseNubankNotification(payload, subject, date) {
  // isIncome tem prioridade — "recebeu" + "transfer" no mesmo assunto = receita
  const isIncome  = /recebeu|recebido|pix recebido|reembolso|estorno/i.test(subject);
  const isExpense = !isIncome && /transfer|pix enviado|pagamento|boleto|compra aprovada/i.test(subject);
  if (!isExpense && !isIncome) return null;

  const findRaw = (p, mime) => {
    if (!p) return '';
    if (p.mimeType === mime && p.body?.data)
      return Buffer.from(p.body.data.replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString('utf-8');
    if (p.parts) { for (const s of p.parts) { const t = findRaw(s, mime); if (t) return t; } }
    return '';
  };
  const raw = findRaw(payload, 'text/plain') || findRaw(payload, 'text/html');
  const src = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  const amtMatch = src.match(/R\$\s*([\d.]+,[\d]{2})/);
  if (!amtMatch) return null;
  const amount = parseFloat(amtMatch[1].replace(/\./g,'').replace(',','.'));
  if (!amount || amount <= 0) return null;

  // Receita: "pelo Pix de NOME e o valor" / "recebida de NOME," / "de NOME foi"
  const fromMatch = src.match(
    /(?:[Pp]elo\s+[Pp]ix\s+de|[Rr]emetente[:\s]+|recebida\s+de|[Dd]e)\s+([A-ZÁÀÃÂÉÊÈÍÌÎÓÒÕÔÚÙÛÇ][^,.<>\n]{2,70}?)(?=\s+e\s+o\s+|\s+foi|\s+com|\s+[Vv]alor|[,.<>\n]|R\$)/
  );
  // Despesa: "para NOME," / "para NOME foi" / "para NOME também"
  const toMatch = src.match(
    /[Pp]ara\s+([A-ZÁÀÃÂÉÊÈÍÌÎÓÒÕÔÚÙÛÇ][^,.<>\n]{2,70}?)(?=[,.<>\n]|\s+foi|\s+com|\s+[Vv]alor|\s+tamb|R\$)/
  );
  const subjectFrom = subject.match(/de\s+([A-Za-záàãâéêèíìîóòõôúùûç][^.!?]+)/i);
  const subjectTo   = subject.match(/para\s+([A-Za-záàãâéêèíìîóòõôúùûç][^.!?]+)/i);

  const description = (
    isIncome
      ? (fromMatch?.[1] || subjectFrom?.[1])
      : (toMatch?.[1]   || subjectTo?.[1])
  )?.trim().slice(0, 80) || subject;

  return { date, description, amount, type: isIncome ? 'income' : 'expense' };
}

async function isAlreadyQueued(msgId) {
  const r = await sbGet(`gmail_queue?msg_id=eq.${msgId}&select=id&limit=1`);
  if (r?.length) return true;
  const r2 = await sbGet(`app_tokens?key=eq.gmail_proc_${msgId}&select=key&limit=1`);
  return !!(r2?.length);
}

export default async function handler(req, res) {
  const log = [];
  let queued = 0, notifImported = 0;

  try {
    const token = await getAccessToken();
    const days  = 50;

    const [cpfToken] = await sbGet('app_tokens?key=eq.user_cpf&select=value');
    const cpf = cpfToken?.value || '';
    log.push(`CPF: ${cpf ? 'configurado' : 'não configurado'}`);

    // ── BTG/EQI PDFs ──────────────────────────────────────────
    const btgMsgs = await searchMessages(token,
      `(filename:EQI OR filename:BTG) filename:Fatura has:attachment newer_than:${days}d`, 10);
    log.push(`BTG/EQI: ${btgMsgs.length} e-mails`);
    for (const { id: msgId } of btgMsgs) {
      if (await isAlreadyQueued(msgId)) continue;
      const msg = await getMessage(token, msgId);
      const date = new Date(parseInt(msg.internalDate)).toISOString().slice(0, 10);
      const pdfPart = findPDFPart(msg.payload);
      if (!pdfPart?.body?.attachmentId) continue;
      await sbPost('gmail_queue', {
        msg_id: msgId, att_id: pdfPart.body.attachmentId,
        bank: 'btg', email_date: date, filename: pdfPart.filename,
        password: cpf, kind: 'pdf', status: 'pending'
      }, 'resolution=ignore-duplicates');
      queued++;
    }

    // ── XP PDFs ───────────────────────────────────────────────
    const xpMsgs = await searchMessages(token,
      `filename:XP has:attachment newer_than:${days}d`, 10);
    log.push(`XP: ${xpMsgs.length} e-mails`);
    for (const { id: msgId } of xpMsgs) {
      if (await isAlreadyQueued(msgId)) continue;
      const msg = await getMessage(token, msgId);
      const date = new Date(parseInt(msg.internalDate)).toISOString().slice(0, 10);
      const pdfPart = findPDFPart(msg.payload);
      if (!pdfPart?.body?.attachmentId) continue;
      await sbPost('gmail_queue', {
        msg_id: msgId, att_id: pdfPart.body.attachmentId,
        bank: 'xp', email_date: date, filename: pdfPart.filename,
        password: cpf.slice(0, 5), kind: 'pdf', status: 'pending'
      }, 'resolution=ignore-duplicates');
      queued++;
    }

    // ── Nubank PDFs (extrato mensal, sem senha) ────────────────
    const nubankPdfMsgs = await searchMessages(token,
      `from:nubank.com.br has:attachment newer_than:${days}d`, 10);
    log.push(`Nubank PDFs: ${nubankPdfMsgs.length} e-mails`);
    for (const { id: msgId } of nubankPdfMsgs) {
      if (await isAlreadyQueued(msgId)) continue;
      const msg = await getMessage(token, msgId);
      const date = new Date(parseInt(msg.internalDate)).toISOString().slice(0, 10);
      const pdfPart = findPDFPart(msg.payload);
      if (!pdfPart?.body?.attachmentId) continue;
      await sbPost('gmail_queue', {
        msg_id: msgId, att_id: pdfPart.body.attachmentId,
        bank: 'nubank', email_date: date, filename: pdfPart.filename,
        password: '', kind: 'pdf', status: 'pending'
      }, 'resolution=ignore-duplicates');
      queued++;
    }

    // ── Nubank notificações (sem PDF — regex direto) ───────────
    const notifMsgs = await searchMessages(token,
      `from:todomundo@nubank.com.br -has:attachment newer_than:${days}d`, 30);
    log.push(`Nubank notificações: ${notifMsgs.length} e-mails`);
    for (const { id: msgId } of notifMsgs) {
      if (await isAlreadyQueued(msgId)) continue;
      const msg     = await getMessage(token, msgId);
      const date    = new Date(parseInt(msg.internalDate)).toISOString().slice(0, 10);
      const headers = msg.payload?.headers || [];
      const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value || '';
      const parsed  = parseNubankNotification(msg.payload, subject, date);

      if (parsed) {
        // Salva na fila com dados já parseados (browser só precisa importar)
        await sbPost('gmail_queue', {
          msg_id: msgId, bank: 'nubank', email_date: date,
          kind: 'notification', parsed, status: 'pending'
        }, 'resolution=ignore-duplicates');
        queued++;
        notifImported++;
      } else {
        // Marca como processado mesmo sem transação (marketing, etc)
        await sbPost('app_tokens', { key: `gmail_proc_${msgId}`, value: '0' }, 'resolution=merge-duplicates');
      }
    }

    log.push(`Total enfileirado: ${queued} itens (${notifImported} notificações prontas)`);
    return res.status(200).json({ success: true, queued, log });

  } catch (err) {
    console.error('[cron-sync]', err);
    return res.status(500).json({ success: false, error: err.message, log });
  }
}
