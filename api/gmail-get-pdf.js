// api/gmail-get-pdf.js
// Baixa um anexo PDF específico do Gmail e retorna como base64

export const config = { api: { bodyParser: true } };

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_KEY;

async function getAccessToken() {
  const r1 = await fetch(`${SB_URL}/rest/v1/app_tokens?key=eq.gmail_refresh_token&select=value`, {
    headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` }
  });
  const [token] = await r1.json();
  if (!token) throw new Error('Gmail não autorizado');

  const r2 = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: token.value,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token'
    })
  });
  const data = await r2.json();
  if (!data.access_token) throw new Error('Falha ao renovar token');
  return data.access_token;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { msgId, attId } = req.body || {};
  if (!msgId || !attId) return res.status(400).json({ error: 'msgId e attId são obrigatórios' });

  try {
    const accessToken = await getAccessToken();
    const r = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}/attachments/${attId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const data = await r.json();
    // Converte base64url para base64 padrão
    const base64 = (data.data || '').replace(/-/g, '+').replace(/_/g, '/');
    return res.status(200).json({ base64 });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
