// api/gmail-callback.js
// Faz as duas pontas da autorização do Google:
//   - /api/gmail-callback?iniciar=1  -> manda você para a tela de permissão do Google
//   - /api/gmail-callback?code=...   -> o Google volta aqui; troca o código por tokens e salva no Supabase
// (Antes eram dois arquivos; viraram um só para caber no limite de funções do plano gratuito da Vercel.)
//
// Permissões pedidas: ler e-mails (faturas) e ler arquivos do Drive (aulas da aba Cursos).

const ESCOPOS = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/drive.readonly'
].join(' ');

export default async function handler(req, res) {
  const { code, error, iniciar } = req.query;

  if (iniciar) {
    const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
    if (!CLIENT_ID) {
      return res.status(500).send('GOOGLE_CLIENT_ID não configurado nas variáveis de ambiente da Vercel.');
    }
    const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' +
      `client_id=${encodeURIComponent(CLIENT_ID)}` +
      `&redirect_uri=${encodeURIComponent('https://financasfrancisco.vercel.app/api/gmail-callback')}` +
      `&response_type=code` +
      `&scope=${encodeURIComponent(ESCOPOS)}` +
      `&access_type=offline` +
      `&prompt=consent`;
    return res.redirect(authUrl);
  }

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
        <h2>✅ Conta Google conectada com sucesso!</h2>
        <p>O app já pode ler seus e-mails (faturas) e os vídeos das aulas no seu Drive.</p>
        <p>Pode fechar esta janela.</p>
      </body></html>
    `);

  } catch (err) {
    console.error('[gmail-callback] erro:', err);
    res.status(500).send(`<h2>❌ Erro: ${err.message}</h2>`);
  }
}
