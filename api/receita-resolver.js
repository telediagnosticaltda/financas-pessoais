import { requireAuth } from './_auth.js';

// api/receita-resolver.js
// Recebe o link de um reel do Instagram e devolve o endereco do video, a legenda
// e a capa. Quem assiste ao video depois e a /api/receita-extrair.
//
// Sao duas funcoes separadas de proposito: cada uma tem 60 segundos na Vercel, e
// juntas (buscar o video + assistir) estourariam esse limite.
//
// Variaveis de ambiente:
//   APIFY_TOKEN  (obrigatoria)
//   APIFY_ACTOR  (opcional — troque aqui se o scraper parar de funcionar)

const ATOR_PADRAO = 'apify~instagram-scraper';
const LIMITE_CAPA = 900 * 1024; // 900 KB

function erro(msg, status = 500) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

// Primeiro valor preenchido entre varios nomes possiveis de campo.
// Cada scraper batiza os campos de um jeito; assim trocar de ator nao quebra tudo.
function campo(item, ...nomes) {
  for (const n of nomes) {
    const v = item?.[n];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

async function baixarCapa(url) {
  if (!url) return { base64: null, mime: null };
  try {
    const r = await fetch(url);
    if (!r.ok) return { base64: null, mime: null };

    const mime = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
    if (!mime.startsWith('image/')) return { base64: null, mime: null };

    const bytes = Buffer.from(await r.arrayBuffer());
    if (bytes.length > LIMITE_CAPA) return { base64: null, mime: null };

    return { base64: bytes.toString('base64'), mime };
  } catch (err) {
    console.error('[resolver] capa falhou:', err.message);
    return { base64: null, mime: null };
  }
}

export default async function handler(req, res) {
  if (!(await requireAuth(req, res))) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  const token = process.env.APIFY_TOKEN;
  if (!token) {
    return res.status(500).json({
      error: 'APIFY_TOKEN nao configurada na Vercel — sem ela o app nao consegue abrir links do Instagram.'
    });
  }

  const ator = process.env.APIFY_ACTOR || ATOR_PADRAO;

  try {
    const url = String((req.body || {}).url || '').trim();
    if (!url) return res.status(400).json({ error: 'Envie o link do reel' });

    if (!/instagram\.com/i.test(url)) {
      return res.status(400).json({ error: 'Esse leitor funciona com links do Instagram' });
    }

    // Tira o ?stkn=... e outros rastreadores que o Instagram gruda no link
    const limpo = url.split('?')[0];

    const resposta = await fetch(
      `https://api.apify.com/v2/acts/${ator}/run-sync-get-dataset-items` +
      `?token=${encodeURIComponent(token)}&timeout=75`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          directUrls: [limpo],
          resultsType: 'posts',
          resultsLimit: 1,
          addParentData: false
        })
      }
    );

    if (!resposta.ok) {
      const detalhe = (await resposta.text()).slice(0, 400);
      console.error('[apify]', resposta.status, detalhe);

      if (resposta.status === 401 || resposta.status === 403) {
        throw erro('O APIFY_TOKEN foi recusado. Confira a chave na Vercel.', 401);
      }
      if (resposta.status === 402) {
        throw erro('O credito da Apify acabou. Veja sua conta em console.apify.com.', 402);
      }
      if (resposta.status === 404) {
        throw erro('O leitor de Instagram configurado nao existe mais. Troque o APIFY_ACTOR.', 404);
      }
      throw erro('O leitor de Instagram nao respondeu. Tente de novo em alguns minutos.', 502);
    }

    const itens = await resposta.json();
    const item = Array.isArray(itens) ? itens[0] : null;

    if (!item) {
      return res.status(200).json({
        ok: false,
        motivo: 'O post nao foi encontrado. Ele precisa ser publico — perfil fechado nao da.'
      });
    }

    const videoUrl = campo(item, 'videoUrl', 'video_url', 'videoUrlHd');
    const legenda  = campo(item, 'caption', 'text', 'description');
    const autor    = campo(item, 'ownerUsername', 'authorUsername', 'author_username', 'username');
    const capaUrl  = campo(item, 'displayUrl', 'thumbnail_url', 'thumbnailUrl', 'imageUrl', 'display_url');

    if (!videoUrl && !legenda) {
      return res.status(200).json({
        ok: false,
        motivo: 'Nao veio nem video nem legenda desse post. Tente o print da tela.'
      });
    }

    const capa = await baixarCapa(capaUrl);

    return res.status(200).json({
      ok: true,
      videoUrl,
      caption: legenda,
      author: autor ? `@${autor.replace(/^@/, '')}` : null,
      sourceUrl: limpo,
      capaBase64: capa.base64,
      capaMime: capa.mime
    });
  } catch (err) {
    console.error('Falha em receita-resolver:', err);
    return res.status(err.status || 500).json({
      error: err.message || 'Erro ao abrir o link do Instagram'
    });
  }
}
