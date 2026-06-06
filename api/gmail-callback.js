// api/gmail-callback.js
// Recebe o código do Google, troca por tokens e salva no Supabase

export default async function handler(req, res) {
  const { code, error } = req.query;

  if (error || !code) {
    return res.status(400).send(`<h2>❌ Autorização negada: ${error || 'código não recebido'}</h2>`);
  }

  const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
  const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
  const REDIRECT_URI  = 'https://financasfrancisco.vercel.app/api/gmail-callback';
  const SB_URL        = process.env.SUPABASE_URL;
  const SB_KEY        = process.env.SUPABASE_KEY;

  try {
    // 1. Trocar código por tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri:  REDIRECT_URI,
        grant_type:    'authorization_code'
      })
    });

    const tokens = await tokenRes.json();

    if (!tokens.refresh_token) {
      return res.status(500).send('<h2>❌ Não foi possível obter o refresh token. Tente autorizar novamente.</h2>');
    }

    // 2. Salvar refresh token no Supabase
    const sbH = {
      'apikey':        SB_KEY,
      'Authorization': `Bearer ${SB_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'resolution=merge-duplicates'
    };

    await fetch(`${SB_URL}/rest/v1/app_tokens`, {
      method:  'POST',
      headers: sbH,
      body:    JSON.stringify({ key: 'gmail_refresh_token', value: tokens.refresh_token })
    });

    res.status(200).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px">
        <h2>✅ Gmail conectado com sucesso!</h2>
        <p>O app já pode acessar seus e-mails para importar faturas automaticamente.</p>
        <p>Pode fechar esta janela.</p>
      </body></html>
    `);

  } catch (err) {
    console.error('[gmail-callback] erro:', err);
    res.status(500).send(`<h2>❌ Erro: ${err.message}</h2>`);
  }
}
