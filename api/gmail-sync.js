// api/gmail-sync.js
// Roda automaticamente todo dia às 9h (configurado no vercel.json)
// Também pode ser disparado manualmente pelo app

import pdf from 'pdf-parse/lib/pdf-parse.js';

export const config = { api: { bodyParser: true } };

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const USER_CPF = process.env.USER_CPF || '';

const sbH = {
  'apikey':        SB_KEY,
  'Authorization': `Bearer ${SB_KEY}`,
  'Content-Type':  'application/json'
};

// ── Supabase helpers ──────────────────────────────────────────
async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sbH });
  return r.json();
}

async function sbInsert(table, data) {
  return fetch(`${SB_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...sbH, 'Prefer': 'return=minimal' },
    body: JSON.stringify(data)
  });
}

// ── Gmail helpers ─────────────────────────────────────────────
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
  if (!data.access_token) throw new Error('Falha ao renovar token do Gmail: ' + JSON.stringify(data));
  return data.access_token;
}

async function searchMessages(accessToken, query, maxResults = 15) {
  const r = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
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
  // Gmail retorna base64url — converte para base64 padrão
  return (data.data || '').replace(/-/g, '+').replace(/_/g, '/');
}

// ── PDF helpers ───────────────────────────────────────────────
async function extractPDFText(base64Data, password = '') {
  const buffer  = Buffer.from(base64Data, 'base64');
  const options = password ? { password } : {};
  const data    = await pdf(buffer, options);
  return data.text || '';
}

// ── Claude helpers ────────────────────────────────────────────
async function parseWithClaude(prompt) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':    'application/json',
      'x-api-key':       ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model:      'claude-opus-4-5',
      max_tokens: 8000,
      messages:   [{ role: 'user', content: prompt }]
    })
  });
  const data = await r.json();
  const text = (data.content || []).map(b => b.text || '').join('').trim();
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try { return JSON.parse(match[0]); } catch { return []; }
}

async function parsePDFTransactions(pdfText) {
  const today = new Date();
  return parseWithClaude(`Você é um especialista em extrair dados de documentos financeiros brasileiros.

Analise o texto abaixo — pode ser uma FATURA DE CARTÃO DE CRÉDITO ou um EXTRATO DE CONTA CORRENTE.

PARA FATURA DE CARTÃO:
- Extraia cada compra/parcela como "expense"
- Estornos e créditos como "income"
- Inclua parcelamentos (cada parcela = uma linha separada)
- NÃO inclua: total da fatura, pagamento de fatura, encargos, IOF, limite

PARA EXTRATO DE CONTA CORRENTE (Nubank, etc):
- "Transferência enviada", "Pagamento de boleto", "Pix enviado" = "expense"
- "Transferência recebida", "Pix recebido", "Depósito", "Salário" = "income"
- Inclua TODAS as movimentações (entradas E saídas)
- NÃO inclua: saldo inicial, saldo final, rendimento da conta, tarifas do extrato
- Para descrição: use o nome do destinatário/remetente, não dados bancários (agência/conta)

Referência de data: ${today.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}

Retorne APENAS um array JSON, sem texto extra:
[{"date":"YYYY-MM-DD","description":"Nome limpo","amount":99.90,"type":"expense"}]

Regras gerais:
- amount: sempre número positivo
- date: YYYY-MM-DD com o ano correto
- type: "expense" para saídas, "income" para entradas
- Retorne SOMENTE o JSON

TEXTO DO DOCUMENTO:
${pdfText.slice(0, 15000)}`);
}

async function parseNubankEmail(emailText, emailDate) {
  return parseWithClaude(`Analise este e-mail de transação do Nubank e extraia a transação.

Data do e-mail: ${emailDate}

Retorne APENAS um array JSON com UMA transação:
[{"date":"YYYY-MM-DD","description":"Nome do estabelecimento ou destinatário","amount":99.90,"type":"expense"}]

Regras:
- type: "expense" para compras/pagamentos/Pix enviado, "income" para recebimentos/Pix recebido
- Se não for uma transação financeira clara, retorne []
- Retorne SOMENTE o JSON

TEXTO DO E-MAIL:
${emailText.slice(0, 3000)}`);
}

// ── Supabase transaction check ────────────────────────────────
async function alreadyImported(externalId) {
  const data = await sbGet(`transactions?external_id=eq.${encodeURIComponent(externalId)}&select=id`);
  return Array.isArray(data) && data.length > 0;
}

async function importTransaction(tx, accountId, externalId) {
  if (await alreadyImported(externalId)) return 'dup';
  const r = await sbInsert('transactions', {
    date:        tx.date,
    description: tx.description,
    amount:      tx.amount,
    type:        tx.type,
    account_id:  accountId,
    source:      'manual',
    external_id: externalId
  });
  return r.ok ? 'ok' : 'err';
}

// ── Find account ID by institution keyword ────────────────────
async function getAccountId(keyword, preferType = null) {
  const accounts = await sbGet('accounts?active=eq.true&select=id,institution,name,type');
  if (!Array.isArray(accounts)) return null;
  const kw = keyword.toLowerCase();
  const matches = accounts.filter(a => (a.institution || '').toLowerCase().includes(kw));
  if (preferType) {
    const preferred = matches.find(a => a.type === preferType);
    if (preferred) return preferred.id;
  }
  return matches[0]?.id || null;
}

// ── Main handler ──────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const log = [];
  let totalImported = 0, totalDuplicates = 0;

  // Suporte a sync completo (desde uma data específica)
  const body = req.body || {};
  const days = body.days || 50; // padrão: 50 dias; full sync: 180 dias

  try {
    const accessToken = await getAccessToken();
    log.push(`✓ Gmail autorizado — buscando últimos ${days} dias`);

    // ── 1. Faturas EQI/BTG (PDF em anexo) ──────────────────────
    let pdfCount = 0; // contador compartilhado entre BTG e XP
    const btgAccountId = await getAccountId('btg', 'credit');
    if (btgAccountId) {
      // Busca específica por EQI ou BTG — evita capturar e-mails do Nubank
      const btgMsgs = await searchMessages(accessToken,
        `(filename:EQI OR filename:BTG) filename:Fatura has:attachment newer_than:${days}d`, 5);
      log.push(`Encontrados ${btgMsgs.length} e-mail(s) EQI/BTG`);

      for (const { id: msgId } of btgMsgs) {
        if (pdfCount >= 1) { log.push('⏸ 1 PDF processado por chamada. Clique novamente para continuar.'); break; }
        const msg  = await getMessage(accessToken, msgId);
        const date = new Date(parseInt(msg.internalDate)).toISOString().slice(0, 10);

        // Encontrar anexo PDF
        const parts  = msg.payload?.parts || [];
        const pdfPart = parts.find(p =>
          p.mimeType === 'application/pdf' ||
          (p.filename || '').toLowerCase().endsWith('.pdf')
        );
        if (!pdfPart?.body?.attachmentId) continue;

        try {
          const b64     = await getAttachment(accessToken, msgId, pdfPart.body.attachmentId);
          const pdfText = await extractPDFText(b64, USER_CPF);

          if (pdfText.trim().length < 100) {
            log.push(`⚠ E-mail ${msgId}: PDF sem texto extraível (possível senha incorreta)`);
            continue;
          }

          const txs = await parsePDFTransactions(pdfText);
          let msgImported = 0;

          for (const [i, tx] of txs.entries()) {
            const extId  = `gmail_${msgId}_${i}`;
            const result = await importTransaction(tx, btgAccountId, extId);
            if (result === 'ok')  { msgImported++; totalImported++; }
            if (result === 'dup') totalDuplicates++;
          }

          pdfCount++;
          log.push(`✓ EQI/BTG (${date}): ${msgImported} transações importadas de ${txs.length} encontradas`);
        } catch (err) {
          log.push(`⚠ Erro ao processar e-mail BTG ${msgId}: ${err.message}`);
        }
      }
    }

    // ── 2. Faturas XP (PDF em anexo) ───────────────────────────
    const xpAccountId = await getAccountId('xp', 'credit');
    if (xpAccountId) {
      const xpMsgs = await searchMessages(accessToken,
        `filename:XP has:attachment newer_than:${days}d`, 5);
      log.push(`Encontrados ${xpMsgs.length} e-mail(s) XP`);

      for (const { id: msgId } of xpMsgs) {
        if (pdfCount >= 1) { log.push('⏸ 1 PDF processado por chamada. Clique novamente para continuar.'); break; }
        const msg     = await getMessage(accessToken, msgId);
        const date    = new Date(parseInt(msg.internalDate)).toISOString().slice(0, 10);
        const parts   = msg.payload?.parts || [];
        const pdfPart = parts.find(p =>
          p.mimeType === 'application/pdf' ||
          (p.filename || '').toLowerCase().endsWith('.pdf')
        );
        if (!pdfPart?.body?.attachmentId) continue;

        try {
          const b64     = await getAttachment(accessToken, msgId, pdfPart.body.attachmentId);
          // XP usa os 5 primeiros dígitos do CPF como senha
          const pdfText = await extractPDFText(b64, USER_CPF.slice(0, 5));

          if (pdfText.trim().length < 100) {
            log.push(`⚠ E-mail XP ${msgId}: PDF sem texto extraível`);
            continue;
          }

          const txs = await parsePDFTransactions(pdfText);
          let msgImported = 0;

          for (const [i, tx] of txs.entries()) {
            const extId  = `gmail_${msgId}_${i}`;
            const result = await importTransaction(tx, xpAccountId, extId);
            if (result === 'ok')  { msgImported++; totalImported++; }
            if (result === 'dup') totalDuplicates++;
          }

          pdfCount++;
          log.push(`✓ XP (${date}): ${msgImported} transações importadas de ${txs.length} encontradas`);
        } catch (err) {
          log.push(`⚠ Erro ao processar e-mail XP ${msgId}: ${err.message}`);
        }
      }
    }

    // ── 3. Transações Nubank (e-mails individuais) ─────────────
    const nubankAccountId = await getAccountId('nubank', 'checking');
    if (nubankAccountId) {
      // Busca e-mails dos últimos 2 dias (cron roda diariamente)
      const nubankMsgs = await searchMessages(accessToken,
        `from:nubank.com.br newer_than:${Math.max(days, 2)}d`, 10);
      log.push(`Encontrados ${nubankMsgs.length} e-mail(s) Nubank`);

      for (const { id: msgId } of nubankMsgs) {
        if (pdfCount >= 1) { log.push('⏸ 1 PDF por chamada. Clique novamente para continuar.'); break; }
        const msg  = await getMessage(accessToken, msgId);
        const date = new Date(parseInt(msg.internalDate)).toISOString().slice(0, 10);

        try {
          // Verificar se tem PDF anexo (extrato mensal)
          const parts   = msg.payload?.parts || [];
          const pdfPart = parts.find(p =>
            p.mimeType === 'application/pdf' ||
            (p.filename || '').toLowerCase().endsWith('.pdf')
          );

          if (pdfPart?.body?.attachmentId) {
            // Extrato PDF do Nubank (sem senha)
            const b64     = await getAttachment(accessToken, msgId, pdfPart.body.attachmentId);
            const pdfText = await extractPDFText(b64, ''); // Nubank não tem senha
            if (pdfText.trim().length > 100) {
              const txs = await parsePDFTransactions(pdfText);
              let msgImported = 0;
              for (const [i, tx] of txs.entries()) {
                const extId  = `gmail_${msgId}_${i}`;
                const result = await importTransaction(tx, nubankAccountId, extId);
                if (result === 'ok')  { msgImported++; totalImported++; }
                if (result === 'dup') totalDuplicates++;
              }
              pdfCount++;
              log.push(`✓ Nubank PDF (${date}): ${msgImported} de ${txs.length} transações importadas`);
            }
          } else {
            // E-mail de transação individual (sem PDF)
            const body = extractEmailBody(msg.payload);
            if (!body) continue;
            const txs = await parseNubankEmail(body, date);
            for (const [i, tx] of txs.entries()) {
              const extId  = `gmail_${msgId}_${i}`;
              const result = await importTransaction(tx, nubankAccountId, extId);
              if (result === 'ok')  totalImported++;
              if (result === 'dup') totalDuplicates++;
            }
            if (txs.length > 0) log.push(`✓ Nubank email (${date}): ${txs.length} transação(ões)`);
          }
        } catch (err) {
          log.push(`⚠ Erro ao processar e-mail Nubank ${msgId}: ${err.message}`);
        }
      }
    }

    return res.status(200).json({
      success: true,
      imported: totalImported,
      duplicates: totalDuplicates,
      log
    });

  } catch (err) {
    console.error('[gmail-sync] erro:', err);
    return res.status(500).json({ success: false, error: err.message, log });
  }
}

// Extrai o texto/HTML do corpo do e-mail recursivamente
function extractEmailBody(payload) {
  if (!payload) return '';
  if (payload.body?.data) {
    return Buffer.from(payload.body.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractEmailBody(part);
      if (text) return text;
    }
  }
  return '';
}
