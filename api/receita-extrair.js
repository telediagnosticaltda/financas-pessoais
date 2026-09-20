import { requireAuth } from './_auth.js';

// api/receita-extrair.js
// Transforma um video, um link, um texto colado ou uma imagem numa receita
// estruturada (ingredientes + passo a passo).
//
// Dois motores de IA, cada um no que faz melhor:
//   - Gemini  -> assiste ao video (audio + imagem). Link do YouTube ou arquivo enviado.
//   - Claude  -> le texto colado, print de tela e foto de receita.
//
// Variaveis de ambiente:
//   GEMINI_API_KEY     (obrigatoria para video)
//   ANTHROPIC_API_KEY  (obrigatoria para texto e imagem)

const MODELOS_GEMINI = ['gemini-3.8-flash', 'gemini-3.7-flash'];
const MODELO_CLAUDE  = 'claude-sonnet-4-6';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';

const CATEGORIAS = [
  'Carnes', 'Aves', 'Peixes e frutos do mar', 'Massas',
  'Arroz e acompanhamentos', 'Sopas e caldos', 'Saladas', 'Lanches',
  'Pães', 'Doces e sobremesas', 'Bebidas', 'Café da manhã',
  'Molhos e temperos', 'Outros'
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// ── Formato de saida, igual para os dois motores ──
const FORMATO = `Responda APENAS com um objeto JSON, sem markdown, sem crases,
sem nenhum texto antes ou depois.

Formato exato:
{
  "found": true | false,
  "title": "nome da receita",
  "category": ${CATEGORIAS.map(c => `"${c}"`).join(' | ')},
  "tags": ["ate 5 tags curtas em minusculas, ex: rapido, airfryer, sem gluten"],
  "servings": "texto curto, ex: 4 porcoes, ou null",
  "total_time_min": numero total de minutos de preparo, ou null,
  "ingredients": ["1 xicara de farinha de trigo", "2 ovos", "..."],
  "steps": ["Passo completo em uma frase ou duas.", "..."],
  "notes": "dica relevante de quem ensinou que nao cabe nos passos, ou null",
  "confidence": "alta" | "media" | "baixa",
  "warnings": ["avisos curtos sobre o que ficou duvidoso ou faltando"]
}

Regras:
- NUNCA invente ingredientes, quantidades ou passos. Esta e a regra mais importante:
  uma receita chutada e pior que nenhuma receita. Se uma quantidade nao for dita nem
  mostrada, escreva o ingrediente sem quantidade e registre isso em warnings.
- ingredients: uma linha por ingrediente, comecando pela quantidade quando ela existir.
  Mantenha as unidades como foram ditas (xicara, colher de sopa, g, ml).
- steps: cada passo completo e independente, na ordem. Nao numere, o aplicativo numera.
- total_time_min: some preparo e cozimento apenas se os tempos forem informados.
  Se nao houver informacao de tempo, use null. Nao estime.
- Responda em portugues do Brasil. Se o material estiver em outro idioma, traduza.
- Ignore pedidos de like e inscricao, links de cupom e afiliado, nomes de
  patrocinadores, hashtags e enderecos de redes sociais.`;

const PROMPT_VIDEO = `Voce esta assistindo a um video de culinaria e sua tarefa e
transcrever a receita ensinada nele.

Use TUDO o que o video oferece:
- o que a pessoa fala (a maior parte das quantidades costuma estar na fala);
- o texto escrito na tela (legendas, cartelas de ingredientes, listas sobrepostas);
- o que aparece na imagem (embalagens, utensilios, tamanho das panelas e formas,
  temperatura e tempo mostrados no forno ou no display do aparelho).

Se a fala e a tela discordarem, prefira o que estiver escrito na tela e registre a
divergencia em warnings.

Se o video NAO ensinar uma receita (for so uma degustacao, uma resenha de restaurante
ou um comentario), responda com "found": false e listas vazias.

${FORMATO}`;

const PROMPT_TEXTO = `Voce esta lendo o material de divulgacao de uma receita de
culinaria: pode ser a legenda de um post, a descricao de um video, o print de uma
tela ou a foto de uma receita escrita em papel.

Sua tarefa e transformar isso numa receita organizada.

Se o material NAO contiver uma receita de fato (so tiver link de afiliado, pedido de
inscricao no canal, hashtags, ou apenas o nome do prato sem o preparo), responda com
"found": false e listas vazias, explicando em warnings o que faltou.

Se houver ingredientes mas o modo de preparo estiver ausente, use "found": true,
preencha o que existe e registre a falta em warnings.

${FORMATO}`;

// ─────────────────────────────────────────────────────────────
// UTILIDADES
// ─────────────────────────────────────────────────────────────
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

function decodeHtml(s) {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'")
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}

function metaTag(html, prop) {
  const a = html.match(new RegExp(
    `<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`, 'i'));
  if (a) return decodeHtml(a[1]);
  const b = html.match(new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`, 'i'));
  return b ? decodeHtml(b[1]) : null;
}

function erro(msg, status = 500) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

function lerJson(texto, ondeErrou) {
  const limpo = String(texto || '')
    .replace(/```json/gi, '').replace(/```/g, '').trim();
  const inicio = limpo.indexOf('{');
  const fim    = limpo.lastIndexOf('}');
  const alvo   = inicio >= 0 && fim > inicio ? limpo.slice(inicio, fim + 1) : limpo;
  try {
    return JSON.parse(alvo);
  } catch {
    console.error(`[${ondeErrou}] resposta nao era JSON:`, limpo.slice(0, 500));
    throw erro('Nao consegui organizar a receita. Tente o print da tela.', 502);
  }
}

// ── Titulo, canal e capa do video (nao depende do Gemini) ──
async function metadadosYoutube(id) {
  const info = {
    source_type: 'youtube',
    source_url: `https://www.youtube.com/watch?v=${id}`,
    video_id: id,
    thumbnail_url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    title: null,
    author: null
  };
  try {
    const r = await fetch(
      `${'https://www.youtube.com'}/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`,
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
  return info;
}

// ─────────────────────────────────────────────────────────────
// GEMINI
// ─────────────────────────────────────────────────────────────
function textoDaInteracao(data) {
  const inter = data.interaction || data;
  let saida = '';

  for (const passo of inter.steps || []) {
    if (passo.type && passo.type !== 'model_output') continue;
    for (const bloco of passo.content || []) {
      if (bloco.type === 'text' && bloco.text) saida += bloco.text + '\n';
    }
  }
  if (!saida && inter.output_text) saida = inter.output_text;

  // Rede de seguranca: formato antigo (generateContent)
  if (!saida && Array.isArray(inter.candidates)) {
    saida = (inter.candidates[0]?.content?.parts || [])
      .map(p => p.text || '').join('\n');
  }
  return saida.trim();
}

async function chamarGemini(apiKey, blocoVideo) {
  let ultimoErro = null;

  // Sem o ajuste de frames, caso a API recuse esse parametro
  const semAjuste = { ...blocoVideo };
  delete semAjuste.processing;

  for (const modelo of MODELOS_GEMINI) {
    for (const bloco of [blocoVideo, semAjuste]) {
      const res = await fetch(`${GEMINI_BASE}/v1beta/interactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          model: modelo,
          input: [bloco, { type: 'text', text: PROMPT_VIDEO }]
        })
      });

      if (res.ok) return lerJson(textoDaInteracao(await res.json()), 'gemini');

      const detalhe = await res.text();
      console.error(`[gemini ${modelo}]`, res.status, detalhe.slice(0, 400));
      ultimoErro = { status: res.status, detalhe };

      // 400 pode ser o parametro "processing": tenta de novo sem ele
      if (res.status === 400 && !/API key/i.test(detalhe) && bloco === blocoVideo) continue;
      break;
    }

    // Modelo inexistente ou sem permissao: tenta o proximo da lista
    if (ultimoErro && (ultimoErro.status === 404 ||
        /not found|not supported/i.test(ultimoErro.detalhe))) continue;
    break;
  }

  if (ultimoErro?.status === 429) {
    throw erro('O limite gratuito do Gemini foi atingido por hoje. Tente amanha ou use o print da tela.', 429);
  }
  if (ultimoErro?.status === 400 && /API key/i.test(ultimoErro.detalhe)) {
    throw erro('A GEMINI_API_KEY parece invalida. Confira a chave na Vercel.', 400);
  }
  throw erro('O Gemini nao conseguiu processar esse video.', 502);
}

// ── Envia um arquivo de video para a Files API do Gemini ──
async function subirVideoGemini(apiKey, bytes, mime) {
  const inicio = await fetch(`${GEMINI_BASE}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(bytes.length),
      'X-Goog-Upload-Header-Content-Type': mime,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ file: { display_name: 'receita' } })
  });

  const enviarPara = inicio.headers.get('x-goog-upload-url');
  if (!inicio.ok || !enviarPara) {
    console.error('[gemini upload start]', inicio.status, await inicio.text());
    throw erro('Falha ao enviar o video para o Gemini.', 502);
  }

  const envio = await fetch(enviarPara, {
    method: 'POST',
    headers: {
      'Content-Length': String(bytes.length),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize'
    },
    body: bytes
  });

  if (!envio.ok) {
    console.error('[gemini upload]', envio.status, await envio.text());
    throw erro('Falha ao enviar o video para o Gemini.', 502);
  }

  const arquivo = (await envio.json()).file;
  if (!arquivo?.name) throw erro('O Gemini nao devolveu o arquivo enviado.', 502);

  // Espera o video ficar pronto (ACTIVE)
  const limite = Date.now() + 40_000;
  let estado = arquivo.state;
  while (estado !== 'ACTIVE') {
    if (estado === 'FAILED') throw erro('O Gemini nao conseguiu processar esse arquivo de video.', 502);
    if (Date.now() > limite) throw erro('O video demorou demais para ser processado. Tente um trecho menor.', 504);
    await new Promise(r => setTimeout(r, 2000));
    const r = await fetch(`${GEMINI_BASE}/v1beta/${arquivo.name}`, {
      headers: { 'x-goog-api-key': apiKey }
    });
    if (!r.ok) break;
    estado = (await r.json()).state;
  }

  return { uri: arquivo.uri, name: arquivo.name, mime: arquivo.mimeType || mime };
}

async function apagarArquivoGemini(apiKey, nome) {
  try {
    await fetch(`${GEMINI_BASE}/v1beta/${nome}`, {
      method: 'DELETE',
      headers: { 'x-goog-api-key': apiKey }
    });
  } catch { /* melhor esforco: os arquivos expiram sozinhos em 48h */ }
}

// ─────────────────────────────────────────────────────────────
// CLAUDE (texto colado, print e foto)
// ─────────────────────────────────────────────────────────────
async function chamarClaude(apiKey, blocos) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODELO_CLAUDE,
      max_tokens: 2000,
      messages: [{ role: 'user', content: blocos }]
    })
  });

  if (!res.ok) {
    console.error('[claude]', res.status, (await res.text()).slice(0, 400));
    throw erro('A Claude API recusou a requisicao.', 502);
  }

  const data = await res.json();
  const texto = (data.content || [])
    .filter(b => b.type === 'text').map(b => b.text).join('\n');

  return lerJson(texto, 'claude');
}

// ─────────────────────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (!(await requireAuth(req, res))) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  const chaveGemini = process.env.GEMINI_API_KEY;
  const chaveClaude = process.env.ANTHROPIC_API_KEY;

  try {
    const { url, videoUrl, mimeType, text, fileData, mediaType } = req.body || {};

    let origem = {
      source_type: 'manual', source_url: null, video_id: null,
      thumbnail_url: null, title: null, author: null
    };
    let bruto = null;

    // ── CAMINHO 1: link do YouTube, assistido pelo Gemini ──
    if (url && youtubeId(String(url).trim())) {
      if (!chaveGemini) {
        return res.status(500).json({
          error: 'GEMINI_API_KEY nao configurada na Vercel — sem ela o app nao consegue assistir ao video.'
        });
      }
      const id = youtubeId(String(url).trim());
      origem = await metadadosYoutube(id);

      bruto = await chamarGemini(chaveGemini, {
        type: 'video',
        uri: `https://www.youtube.com/watch?v=${id}`,
        processing: { type: 'static', fps: 0.25 }
      });

    // ── CAMINHO 2: arquivo de video enviado pelo usuario (reel, TikTok, celular) ──
    } else if (videoUrl) {
      if (!chaveGemini) {
        return res.status(500).json({ error: 'GEMINI_API_KEY nao configurada na Vercel.' });
      }

      const baixado = await fetch(videoUrl);
      if (!baixado.ok) throw erro('Nao consegui ler o video enviado.', 502);
      const bytes = Buffer.from(await baixado.arrayBuffer());

      if (bytes.length > 95 * 1024 * 1024) {
        throw erro('Video grande demais (limite de 95 MB).', 413);
      }

      const mime = mimeType || baixado.headers.get('content-type') || 'video/mp4';
      const arquivo = await subirVideoGemini(chaveGemini, bytes, mime);

      origem.source_type = 'video';
      try {
        bruto = await chamarGemini(chaveGemini, {
          type: 'video', uri: arquivo.uri, mime_type: arquivo.mime,
          processing: { type: 'static', fps: 0.25 }
        });
      } finally {
        await apagarArquivoGemini(chaveGemini, arquivo.name);
      }

    // ── CAMINHO 3: outro link (Instagram, TikTok, blog) ──
    } else if (url) {
      const limpo = String(url).trim();
      const ehInsta  = /instagram\.com/i.test(limpo);
      const ehTiktok = /tiktok\.com/i.test(limpo);
      origem.source_type = ehInsta ? 'instagram' : (ehTiktok ? 'tiktok' : 'link');
      origem.source_url  = limpo;

      let texto = '';
      try {
        const r = await fetch(limpo, {
          headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9' },
          redirect: 'follow'
        });
        if (r.ok) {
          const html = await r.text();
          origem.title         = metaTag(html, 'og:title');
          origem.thumbnail_url = metaTag(html, 'og:image');
          texto = [origem.title, metaTag(html, 'og:description')].filter(Boolean).join('\n\n');
        }
      } catch (err) {
        console.error('[receita] link generico falhou:', err.message);
      }

      if (texto.replace(/\s+/g, ' ').trim().length < 80) {
        return res.status(200).json({
          found: false, ...origem, ingredients: [], steps: [],
          warnings: [
            (ehInsta || ehTiktok)
              ? 'Essa plataforma nao deixa o app ler o video de fora do aplicativo dela. Baixe o video pelo proprio app e use a aba "Enviar video" — ai o Gemini assiste.'
              : 'Nao consegui ler texto suficiente nesse link. Cole a receita ou mande um print da tela.'
          ]
        });
      }

      if (!chaveClaude) return res.status(500).json({ error: 'ANTHROPIC_API_KEY nao configurada' });
      bruto = await chamarClaude(chaveClaude, [
        { type: 'text', text: `MATERIAL ORIGINAL:\n\n${texto}` },
        { type: 'text', text: PROMPT_TEXTO }
      ]);

    // ── CAMINHO 4: texto colado ou imagem ──
    } else if (text || fileData) {
      if (!chaveClaude) return res.status(500).json({ error: 'ANTHROPIC_API_KEY nao configurada' });

      const blocos = [];

      if (fileData) {
        const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
        if (!ok.includes(mediaType)) {
          return res.status(400).json({ error: `Tipo nao suportado: ${mediaType}` });
        }
        origem.source_type = 'imagem';
        blocos.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: fileData } });
      }

      if (text) {
        const t = String(text).trim();
        if (t.length < 30 && !fileData) {
          return res.status(400).json({ error: 'Texto curto demais para virar receita' });
        }
        if (!fileData) origem.source_type = 'texto';
        blocos.push({ type: 'text', text: `MATERIAL ORIGINAL:\n\n${t}` });
      }

      blocos.push({ type: 'text', text: PROMPT_TEXTO });
      bruto = await chamarClaude(chaveClaude, blocos);

    } else {
      return res.status(400).json({ error: 'Envie um link, um video, um texto ou uma imagem' });
    }

    // ── Normaliza a resposta ──
    const lista = v => (Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean) : []);
    const ingredients = lista(bruto.ingredients);
    const steps       = lista(bruto.steps);
    const tempo       = Number(bruto.total_time_min);

    return res.status(200).json({
      found:          bruto.found !== false && (ingredients.length > 0 || steps.length > 0),
      title:          bruto.title || origem.title || null,
      category:       CATEGORIAS.includes(bruto.category) ? bruto.category : 'Outros',
      tags:           lista(bruto.tags).slice(0, 5).map(t => t.toLowerCase()),
      servings:       bruto.servings || null,
      total_time_min: Number.isFinite(tempo) && tempo > 0 ? Math.round(tempo) : null,
      ingredients,
      steps,
      notes:          bruto.notes || null,
      confidence:     bruto.confidence || 'media',
      warnings:       lista(bruto.warnings),
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
