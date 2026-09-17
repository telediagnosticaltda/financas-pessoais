// api/_auth.js
// Valida o token de sessao do Supabase enviado pelo navegador.
// Arquivos comecando com "_" nao viram rotas na Vercel.

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_KEY;

// Cache curto para nao consultar o Supabase a cada chamada
const cache = new Map();
const TTL = 60_000;

export async function requireAuth(req, res) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  if (!token) {
    res.status(401).json({ error: 'Nao autenticado' });
    return false;
  }

  const hit = cache.get(token);
  if (hit && Date.now() - hit.at < TTL) {
    if (hit.ok) return true;
    res.status(401).json({ error: 'Sessao invalida' });
    return false;
  }

  try {
    const r = await fetch(`${SB_URL}/auth/v1/user`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${token}` }
    });
    const ok = r.ok;
    cache.set(token, { ok, at: Date.now() });

    if (!ok) {
      res.status(401).json({ error: 'Sessao invalida ou expirada' });
      return false;
    }
    return true;
  } catch (err) {
    console.error('[_auth]', err);
    res.status(500).json({ error: 'Falha ao validar a sessao' });
    return false;
  }
}

// Protecao do cron: nao ha sessao, entao usa um segredo proprio.
// Aceita header x-cron-secret ou ?secret= na URL.
export function requireCronSecret(req, res) {
  const expected = process.env.CRON_SECRET;

  if (!expected) {
    res.status(500).json({ error: 'CRON_SECRET nao configurado' });
    return false;
  }

  const url = new URL(req.url, 'http://localhost');
  const given = req.headers['x-cron-secret'] || url.searchParams.get('secret') || '';

  if (given !== expected) {
    res.status(401).json({ error: 'Nao autorizado' });
    return false;
  }
  return true;
}
