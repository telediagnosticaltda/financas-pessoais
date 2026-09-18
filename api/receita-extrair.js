import { requireAuth } from './_auth.js';

// api/receita-extrair.js
// Recebe um link (YouTube/Instagram), um texto colado ou uma imagem (print/foto)
// e devolve a receita estruturada em ingredientes + passo a passo.
//
// Variavel de ambiente necessaria: ANTHROPIC_API_KEY

const MODEL = 'claude-sonnet-4-6';

const CATEGORIAS = [
  'Carnes', 'Aves', 'Peixes e frutos do mar', 'Massas',
  'Arroz e acompanhamentos', 'Sopas e caldos', 'Saladas', 'Lanches',
  'Pães', 'Doces e sobremesas', 'Bebidas', 'Café da manhã',
  'Molhos e temperos', 'Outros'
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const PROMPT = `Voce esta lendo o material de divulgacao de uma receita de culinaria:
pode ser a descricao de um video do YouTube, a legenda de um post do Instagram,
o print de uma tela ou a foto de uma receita escrita em papel.

Sua tarefa e transformar isso numa receita organizada.

Responda APENAS com um objeto JSON, sem markdown, sem crases, sem nenhum texto
antes ou depois.

Formato exato:
{
  "found": true | false,
  "title": "nome da receita",
  "category": uma destas opcoes exatas: ${CATEGORIAS.map(c => `"${c}"`).join(' | ')},
  "tags": ["ate 5 tags curtas em minusculas, ex: rapido, airfryer, sem gluten"],
  "servings": "texto curto, ex: 4 porcoes, ou null",
  "total_time_min": numero total de minutos de preparo, ou null,
  "ingredients": ["1 xicara de farinha de trigo", "2 ovos", "..."],
  "steps": ["Passo completo em uma frase ou duas.", "..."],
  "notes": "dica relevante do autor que nao cabe nos passos, ou null",
  "confidence": "alta" | "media" | "baixa",
  "warnings": ["avisos curtos sobre o que ficou faltando"]
}

Regras importantes:
- NUNCA invente ingredientes, quantidades ou passos. Esta e a regra mais importante:
  uma receita chutada e pior que nenhuma receita.
- Se o texto NAO contiver uma receita de fato (so tiver link de afiliado, pedido de
  inscricao no canal, hashtags, ou apenas o nome do prato sem o preparo), responda
  com "found": false e deixe ingredients e steps como listas vazias. Explique em
  warnings o que faltou.
- Se houver ingredientes mas o modo de preparo estiver ausente, ainda assim use
  "found": true, preencha o que existe e registre a falta em warnings.
- ingredients: uma linha por ingrediente, comecando pela quantidade quando ela existir.
  Mantenha as unidades como o autor escreveu (xicara, colher de sopa, g, ml).
- steps: escreva cada passo de forma completa e independente, na ordem.
  Nao numere os passos, a numeracao e feita pelo aplicativo.
- total_time_min: some preparo e cozimento. Se o texto disser "40 minutos", use 40.
  Se nao houver informacao de tempo, use null. Nao estime.
- Responda em portugues do Brasil. Se o material original estiver em outro idioma,
  traduza os ingredientes e os passos.
- Ignore completamente: pedidos de like e inscricao, links de cupom e afiliado,
  nomes de patrocinadores, listas de hashtags e enderecos de redes sociais.`;

// ── Extracao do ID do YouTube em qualquer formato de link ──
function youtubeId(url) {
  const padroes = [
    /(?:youtube\.com\/watch\?(?:.*&)?v=)([\w-]{11})/,
    /(?:youtu\.be\/)([\w-]{11})/,
    /(?:youtube\.com\/shorts\/)([\w-]{11})/,
    /(?:youtube\.com\/embed\/)([\w-]{11})/,
    /(?:youtube\.com\/live\/)([\w-]{11})/
  ];
  for (const p of padroes) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

function metaTag(html, prop) {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`, 'i'
  );
  const m = html.match(re);
  if (m) return decodeHtml(m[1]);
  // Ordem invertida dos atributos
  const re2 = new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`, 'i'
  );
  const m2 = html.match(re2);
  return m2 ? decodeHtml(m2[1]) : null;
}

function decodeHtml(s) {
  return s
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

// ── YouTube: titulo, canal, capa e descricao completa ──
async function lerYoutube(id) {
  const info = {
    source_type: 'youtube',
    source_url: `https://www.youtube.com/watch?v=${id}`,
    video_id: id,
    thumbnail_url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    title: null,
    author: null,
    texto: ''
  };

  // 1. oEmbed: titulo e canal de forma estavel e oficial
  try {
    const r = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`,
      { headers: { 'User-Agent': UA } }
    );
    if (r.ok) {
      const j = await r.json();
      info.title  = j.title || null;
      info.author = j.author_name || null;
      if (j.thumbnail_url) info.thumbnail_url = j.thumbnail_url;
    }
  } catch (err) {
    console.error('[receita] oembed falhou:', err.message);
  }

  // 2. Pagina do video: a descricao completa, que e onde a receita costuma estar
  try {
    const r = await fetch(`https://www.youtube.com/watch?v=${id}&hl=pt-BR`, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9' }
    });
    if (r.ok) {
      const html = await r.text();
      let descricao = null;

      const m = html.match(/"shortDescription":"((?:\\.|[^"\\])*)"/);
      if (m) {
        try { descricao = JSON.parse(`"${m[1]}"`); } catch { /* ignora */ }
      }
      if (!descricao) descricao = metaTag(html, 'og:description');
      if (!info.title) info.title = metaTag(html, 'og:title');

      if (descricao) info.texto = descricao;
    }
  } catch (err) {
    console.error('[receita] pagina do youtube falhou:', err.message);
  }

  const cabecalho = [info.title, info.author ? `Canal: ${info.author}` : null]
    .filter(Boolean).join('\n');
  info.texto = [cabecalho, info.texto].filter(Boolean).join('\n\n');

  return info;
}

// ── Outros links (Instagram, TikTok, blogs): tenta as meta tags ──
async function lerLinkGenerico(url) {
  const ehInsta  = /instagram\.com/i.test(url);
  const ehTiktok = /tiktok\.com/i.test(url);

  const info = {
    source_type: ehInsta ? 'instagram' : (ehTiktok ? 'tiktok' : 'link'),
    source_url: url,
    video_id: null,
    thumbnail_url: null,
    title: null,
    author: null,
    texto: ''
  };

  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9' },
      redirect: 'follow'
    });
    if (r.ok) {
      const html = await r.text();
      info.title         = metaTag(html, 'og:title');
      info.thumbnail_url = metaTag(html, 'og:image');
      const desc         = metaTag(html, 'og:description');
      info.texto = [info.title, desc].filter(Boolean).join('\n\n');
    }
  } catch (err) {
    console.error('[receita] link generico falhou:', err.message);
  }

  return info;
}

async function chamarClaude(apiKey, blocos) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      messages: [{ role: 'user', content: blocos }]
    })
  });

  if (!response.ok) {
    const detalhe = await response.text();
    console.error('Erro da Claude API:', response.status, detalhe);
    const e = new Error('A Claude API recusou a requisicao');
    e.status = 502;
    throw e;
  }

  const data = await response.json();
  const texto = (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();

  const limpo = texto.replace(/```json/gi, '').replace(/```/g, '').trim();

  try {
    return JSON.parse(limpo);
  } catch {
    console.error('Resposta nao era JSON valido:', limpo.slice(0, 500));
    const e = new Error('Nao consegui organizar a receita. Tente colar o texto na mao.');
    e.status = 502;
    throw e;
  }
}

export default async function handler(req, res) {
  if (!(await requireAuth(req, res))) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY nao configurada' });
  }

  try {
    const { url, text, fileData, mediaType } = req.body || {};

    let origem = {
      source_type: 'manual',
      source_url: null,
      video_id: null,
      thumbnail_url: null,
      title: null,
      author: null,
      texto: ''
    };

    // ── 1. De onde vem o material ──
    if (url) {
      const limpo = String(url).trim();
      const ytId = youtubeId(limpo);
      origem = ytId ? await lerYoutube(ytId) : await lerLinkGenerico(limpo);

      const util = (origem.texto || '').replace(/\s+/g, ' ').trim();
      if (util.length < 80) {
        return res.status(200).json({
          found: false,
          ...origem,
          ingredients: [],
          steps: [],
          warnings: [
            origem.source_type === 'instagram'
              ? 'O Instagram nao deixa o app ler a legenda de fora do aplicativo. Copie a legenda do post e cole na aba "Colar texto", ou mande um print da tela.'
              : 'Nao consegui ler texto suficiente nesse link. Cole a descricao ou mande um print da tela.'
          ]
        });
      }
    } else if (text) {
      origem.source_type = 'texto';
      origem.texto = String(text).trim();
      if (origem.texto.length < 30) {
        return res.status(400).json({ error: 'Texto curto demais para virar receita' });
      }
    } else if (!fileData) {
      return res.status(400).json({ error: 'Envie um link, um texto ou uma imagem' });
    }

    // ── 2. Monta a mensagem para a Claude ──
    const blocos = [];

    if (fileData) {
      const permitidos = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
      if (!permitidos.includes(mediaType)) {
        return res.status(400).json({
          error: `Tipo nao suportado: ${mediaType}. Use JPEG, PNG, WEBP ou GIF.`
        });
      }
      origem.source_type = origem.source_url ? origem.source_type : 'imagem';
      blocos.push({
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data: fileData }
      });
    }

    if (origem.texto) {
      blocos.push({ type: 'text', text: `MATERIAL ORIGINAL:\n\n${origem.texto}` });
    }

    blocos.push({ type: 'text', text: PROMPT });

    const r = await chamarClaude(apiKey, blocos);

    // ── 3. Normaliza a resposta ──
    const lista = v => (Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean) : []);

    const ingredients = lista(r.ingredients);
    const steps       = lista(r.steps);
    const found       = r.found !== false && (ingredients.length > 0 || steps.length > 0);

    return res.status(200).json({
      found,
      title:          r.title || origem.title || null,
      category:       CATEGORIAS.includes(r.category) ? r.category : 'Outros',
      tags:           lista(r.tags).slice(0, 5).map(t => t.toLowerCase()),
      servings:       r.servings || null,
      total_time_min: Number.isFinite(Number(r.total_time_min)) && Number(r.total_time_min) > 0
                        ? Math.round(Number(r.total_time_min)) : null,
      ingredients,
      steps,
      notes:          r.notes || null,
      confidence:     r.confidence || 'media',
      warnings:       lista(r.warnings),
      source_type:    origem.source_type,
      source_url:     origem.source_url,
      video_id:       origem.video_id,
      thumbnail_url:  origem.thumbnail_url,
      author:         origem.author
    });
  } catch (err) {
    console.error('Falha em receita-extrair:', err);
    return res.status(err.status || 500).json({
      error: err.message || 'Erro interno ao ler a receita'
    });
  }
}
