import { requireAuth } from './_auth.js';
import { getGmailAccessToken, buscarFolhas, REMETENTE_FOLHA } from './_folha.js';

// api/folha-sync.js
// Botão "Buscar e-mail agora" da aba Funcionárias.
// Devolve só os metadados dos e-mails da folha; o navegador baixa e lê os PDFs.

export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  if (!(await requireAuth(req, res))) return;

  try {
    const days = Math.min(parseInt(req.body?.days) || 45, 120);
    const token = await getGmailAccessToken();
    const folhas = await buscarFolhas(token, days);
    return res.status(200).json({ success: true, remetente: REMETENTE_FOLHA, folhas });
  } catch (err) {
    console.error('[folha-sync]', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
