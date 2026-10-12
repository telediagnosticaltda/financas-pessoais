// api/_folha.js
// Busca no Gmail os e-mails fechamento da folha das funcionárias.
// Remetente: pessoal4@cioarato.com.br — 3 anexos PDF por e-mail:
//   1 DARF (das duas funcionárias) + 2 holerites (um para cada).
// Arquivos começando com "_" não viram rotas na Vercel.

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_KEY;

export const REMETENTE_FOLHA = 'pessoal4@cioarato.com.br';

export async function getGmailAccessToken() {
  const r1 = await fetch(`${SB_URL}/rest/v1/app_tokens?key=eq.gmail_refresh_token&select=value`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }
  });
  const [token] = await r1.json();
  if (!token) throw new Error('Gmail não autorizado');
  const r2 = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: token.value,
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type:    'refresh_token'
    })
  });
  const d = await r2.json();
  if (!d.access_token) throw new Error('Falha ao renovar token Gmail');
  return d.access_token;
}

// Coleta TODOS os anexos PDF do e-mail (não só o primeiro)
function coletarPDFs(payload, out = []) {
  if (!payload) return out;
  const nome = (payload.filename || '').toLowerCase();
  const ehPdf = payload.mimeType === 'application/pdf' || nome.endsWith('.pdf');
  if (ehPdf && payload.body?.attachmentId) {
    out.push({ attId: payload.body.attachmentId, filename: payload.filename || '' });
  }
  (payload.parts || []).forEach(p => coletarPDFs(p, out));
  return out;
}

// Retorna [{ msgId, date, subject, atts: [{attId, filename}] }]
export async function buscarFolhas(accessToken, days = 45) {
  const q = `from:${REMETENTE_FOLHA} has:attachment newer_than:${days}d`;
  const r = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=20`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const lista = (await r.json()).messages || [];

  const folhas = [];
  for (const { id } of lista) {
    const rm = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const msg = await rm.json();
    const atts = coletarPDFs(msg.payload);
    if (!atts.length) continue;
    const headers = msg.payload?.headers || [];
    const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value || '';
    const date = new Date(parseInt(msg.internalDate)).toISOString().slice(0, 10);
    folhas.push({ msgId: id, date, subject, atts });
  }
  folhas.sort((a, b) => a.date.localeCompare(b.date));
  return folhas;
}
