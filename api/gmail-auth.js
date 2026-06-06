// api/gmail-auth.js
// Redireciona o usuário para a tela de autorização do Google

export default function handler(req, res) {
  const CLIENT_ID    = process.env.GOOGLE_CLIENT_ID;
  const REDIRECT_URI = 'https://financasfrancisco.vercel.app/api/gmail-callback';

  if (!CLIENT_ID) {
    return res.status(500).send('GOOGLE_CLIENT_ID não configurado nas variáveis de ambiente da Vercel.');
  }

  const scope   = 'https://www.googleapis.com/auth/gmail.readonly';
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' +
    `client_id=${encodeURIComponent(CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(scope)}` +
    `&access_type=offline` +
    `&prompt=consent`;

  res.redirect(authUrl);
}
