// api/gmail-sync.js
// Retorna APENAS metadados dos e-mails (sem baixar PDFs ainda)
// Browser verifica quais já foram importados e solicita apenas o necessário

export const config = { api: { bodyParser: true } };

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_KEY;

const sbH = { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };

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
      refresh_token: token.value,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token'
    })
  });
  const data = await r.json();
  if (!data.access_token) throw new Error('Falha ao renovar token do Gmail');
  return data.access_token;
}

async function searchMessages(accessToken, query, max) {
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

async function getMessageMinimal(accessToken, id) {
  const r = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=minimal`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  return r.json();
}


// Busca recursiva por anexo PDF
function findPDFPart(payload) {
  if (!payload) return null;
  const isPdf = payload.mimeType === 'application/pdf' ||
    (payload.filename || '').toLowerCase().endsWith('.pdf');
  if (isPdf && payload.body?.attachmentId) return payload;
  if (payload.parts) {
    for (const part of payload.parts) {
      const found = findPDFPart(part);
      if (found) return found;
    }
  }
  return null;
}

// Parseia notificação do Nubank diretamente com regex (sem Claude)
function parseNubankNotification(payload, subject, date) {
  // Determina tipo pela linha de assunto
  const isExpense = /transfer|pix enviado|pagamento|boleto|compra aprovada/i.test(subject);
  const isIncome  = /recebeu|recebido|pix recebido|reembolso|estorno/i.test(subject);
  if (!isExpense && !isIncome) return null; // não é transação

  // Tenta text/plain primeiro, depois HTML
  const findRaw = (p, mime) => {
    if (!p) return '';
    if (p.mimeType === mime && p.body?.data)
      return Buffer.from(p.body.data.replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString('utf-8');
    if (p.parts) { for (const s of p.parts) { const t = findRaw(s, mime); if (t) return t; } }
    return '';
  };
  const raw = findRaw(payload, 'text/plain') || findRaw(payload, 'text/html');
  const src = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  // Extrai valor: R$ X.XXX,XX ou R$ XXX,XX
  const amtMatch = src.match(/R\$\s*([\d.]+,[\d]{2})/);
  if (!amtMatch) return null;
  const amount = parseFloat(amtMatch[1].replace(/\./g,'').replace(',','.'));
  if (!amount || amount <= 0) return null;

  // Extrai nome do destinatário/remetente
  const toMatch   = src.match(/para\s+([A-Za-záàãâéêèíìîóòõôúùûçÁÀÃÂÉÊÈÍÌÎÓÒÕÔÚÙÛÇ][^.\n<R]{3,50}?)(?:\s+foi|\s+com|\.|\n|R\$)/i);
  const fromMatch = src.match(/de\s+([A-Za-záàãâéêèíìîóòõôúùûçÁÀÃÂÉÊÈÍÌÎÓÒÕÔÚÙÛÇ][^.\n<R]{3,50}?)(?:\s+foi|\s+com|\.|\n|R\$)/i);
  // Também tenta pegar do assunto (ex: "Você recebeu R$ X de NOME")
  const subjectFrom = subject.match(/de\s+([A-Za-záàãâéêèíìîóòõôúùûç][^.]+)$/i);
  const subjectTo   = subject.match(/para\s+([A-Za-záàãâéêèíìîóòõôúùûç][^.]+)$/i);

  const description = (
    (isExpense ? (toMatch?.[1] || subjectTo?.[1]) : (fromMatch?.[1] || subjectFrom?.[1]))
    || subject
  ).trim().slice(0, 80);

  return { date, description, amount, type: isExpense ? 'expense' : 'income' };
}

// Extrai text/plain do e-mail (sem HTML — tem o valor limpo)
function extractPlainText(payload) {
  if (!payload) return '';
  const find = (p) => {
    if (!p) return '';
    if (p.mimeType === 'text/plain' && p.body?.data) {
      return Buffer.from(p.body.data.replace(/-/g,'+').replace(/_/g,'/'), 'base64')
        .toString('utf-8').replace(/\s+/g, ' ').trim();
    }
    if (p.parts) {
      for (const sub of p.parts) { const t = find(sub); if (t && t.length > 20) return t; }
    }
    return '';
  };
  return find(payload);
}

// Extrai texto limpo do corpo do e-mail (HTML → texto limpo)
function extractTextFromPayload(payload) {
  if (!payload) return '';
  const findText = (p) => {
    if (!p) return '';
    if ((p.mimeType === 'text/plain' || p.mimeType === 'text/html') && p.body?.data) {
      const raw = Buffer.from(p.body.data.replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString('utf-8');
      return raw
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')  // remove JS
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')    // remove CSS
        .replace(/<[^>]+>/g, ' ')                            // remove tags HTML
        .replace(/https?:\/\/\S+/g, ' ')                    // remove URLs
        .replace(/[^\w\sÀ-ÿR$.,\-:]/g, ' ')                // remove chars especiais
        .replace(/\s+/g, ' ')
        .trim();
    }
    if (p.parts) {
      for (const sub of p.parts) {
        const t = findText(sub);
        if (t && t.length > 30) return t;
      }
    }
    return '';
  };
  return findText(payload);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const log = [];
  try {
    const accessToken = await getAccessToken();
    const days = req.body?.days || 50;

    const [cpfToken] = await sbGet('app_tokens?key=eq.user_cpf&select=value');
    const cpf = cpfToken?.value || '';
    log.push(cpf ? `✓ CPF configurado (${cpf.length} dígitos)` : '⚠ CPF não configurado');
    log.push(`✓ Gmail autorizado — buscando últimos ${days} dias`);

    const emails = []; // Apenas metadados, sem baixar PDFs

    // ── BTG/EQI ────────────────────────────────────────────────
    const btgMsgs = await searchMessages(accessToken,
      `(filename:EQI OR filename:BTG) filename:Fatura has:attachment newer_than:${days}d`, 20);
    log.push(`Encontrados ${btgMsgs.length} e-mail(s) BTG/EQI`);
    for (const { id: msgId } of btgMsgs) {
      const msg = await getMessage(accessToken, msgId);
      const date = new Date(parseInt(msg.internalDate)).toISOString().slice(0, 10);
      const pdfPart = (msg.payload?.parts || []).find(p =>
        p.mimeType === 'application/pdf' || (p.filename || '').toLowerCase().endsWith('.pdf'));
      if (!pdfPart?.body?.attachmentId) continue;
      emails.push({ msgId, attId: pdfPart.body.attachmentId, filename: pdfPart.filename, bank: 'btg', date, password: cpf });
    }

    // ── XP ─────────────────────────────────────────────────────
    const xpMsgs = await searchMessages(accessToken,
      `filename:XP has:attachment newer_than:${days}d`, 20);
    log.push(`Encontrados ${xpMsgs.length} e-mail(s) XP`);
    for (const { id: msgId } of xpMsgs) {
      const msg = await getMessage(accessToken, msgId);
      const date = new Date(parseInt(msg.internalDate)).toISOString().slice(0, 10);
      const pdfPart = (msg.payload?.parts || []).find(p =>
        p.mimeType === 'application/pdf' || (p.filename || '').toLowerCase().endsWith('.pdf'));
      if (!pdfPart?.body?.attachmentId) continue;
      emails.push({ msgId, attId: pdfPart.body.attachmentId, filename: pdfPart.filename, bank: 'xp', date, password: cpf.slice(0, 5) });
    }

    // ── Nubank PDFs (extrato mensal) ───────────────────────────
    const nubankMsgs = await searchMessages(accessToken,
      `from:nubank.com.br has:attachment newer_than:${days}d`, 20);
    log.push(`Encontrados ${nubankMsgs.length} e-mail(s) Nubank com PDF`);
    for (const { id: msgId } of nubankMsgs) {
      const msg = await getMessage(accessToken, msgId);
      const date = new Date(parseInt(msg.internalDate)).toISOString().slice(0, 10);
      const pdfPart = findPDFPart(msg.payload);
      if (!pdfPart?.body?.attachmentId) continue;
      emails.push({ msgId, attId: pdfPart.body.attachmentId, filename: pdfPart.filename, bank: 'nubank', date, password: '' });
    }

    // ── Nubank notificações (sem anexo — só últimos 35 dias, filtra marketing) ──
    const nubankNotifs = await searchMessages(accessToken,
      `from:todomundo@nubank.com.br -has:attachment newer_than:35d`, 50);
    log.push(`Encontrados ${nubankNotifs.length} e-mail(s) Nubank de notificação`);

    // Notificações: parsear com regex direto no servidor (sem Claude, mais confiável)
    const emailTexts = [];
    let skippedNotif = 0;
    for (const { id: msgId } of nubankNotifs.slice(0, 8)) {
      try {
        const msg     = await getMessage(accessToken, msgId);
        const date    = new Date(parseInt(msg.internalDate)).toISOString().slice(0, 10);
        const headers = msg.payload?.headers || [];
        const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value || '';
        const parsed  = parseNubankNotification(msg.payload, subject, date);
        if (!parsed) { skippedNotif++; continue; }
        emailTexts.push({ msgId, bank: 'nubank', date, parsed });
      } catch (e) {
        skippedNotif++;
      }
    }
    log.push(`Notificações: ${emailTexts.length} transações + ${skippedNotif} ignoradas`);

    log.push(`Total: ${emails.length} PDF(s), ${emailTexts.length} notificação(ões) encontrados`);

    // Ordenar do mais antigo para o mais recente
    emails.sort((a, b) => a.date.localeCompare(b.date));
    emailTexts.sort((a, b) => a.date.localeCompare(b.date));

    return res.status(200).json({ success: true, emails, emailTexts, log });

  } catch (err) {
    console.error('[gmail-sync]', err);
    return res.status(500).json({ success: false, error: err.message, log });
  }
}
