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

const MODELOS_GEMINI = ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash'];
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

Um mesmo material pode ensinar VARIAS receitas ("5 molhos para macarrao",
"3 marinadas", "cafe da manha da semana"). Por isso a resposta e sempre uma LISTA.

Formato exato:
{
  "recipes": [
    {
      "title": "nome da receita",
      "category": ${CATEGORIAS.map(c => `"${c}"`).join(' | ')},
      "tags": ["ate 5 tags curtas em minusculas, ex: rapido, airfryer, sem gluten"],
      "servings": "texto curto, ex: 4 porcoes, ou null",
      "total_time_min": numero de minutos de preparo desta receita, ou null,
      "start_time": "momento em que esta receita comeca, no formato MM:SS, ou null",
      "ingredients": ["1 xicara de farinha de trigo", "2 ovos", "..."],
      "steps": ["Passo completo em uma frase ou duas.", "..."],
      "notes": "dica de quem ensinou que nao cabe nos passos, ou null"
    }
  ],
  "confidence": "alta" | "media" | "baixa",
  "warnings": ["avisos curtos sobre o que ficou duvidoso ou faltando"]
}

Quantas receitas separar:
- Uma entrada por PRATO DISTINTO ensinado. Cinco molhos diferentes sao cinco entradas,
  cada uma com seu proprio titulo ("Molho de queijo", "Molho de tomate assado"...),
  nunca um titulo generico como "5 molhos".
- Se houver uma base comum a varias receitas (um refogado, uma massa, um caldo),
  REPITA em cada entrada os ingredientes e os passos dessa base. Cada entrada precisa
  ser suficiente sozinha: quem abrir so ela tem que conseguir cozinhar.
- Variacoes triviais da mesma receita (trocar o queijo, versao sem lactose) NAO viram
  entradas novas: ficam em notes da receita principal.
- Se o material ensinar so uma receita, devolva uma lista com um item so.
- Se NAO houver receita nenhuma (degustacao, resenha de restaurante, so hashtags ou
  so o nome do prato sem preparo), devolva "recipes": [] e explique em warnings.
- start_time: so para video, marcando onde aquela receita comeca. Para texto ou
  imagem, use null. Nunca estime: se nao souber, null.

Regras de conteudo:
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
transcrever TODAS as receitas ensinadas nele.

Antes de escrever, percorra o video inteiro e conte quantos pratos diferentes sao
preparados. Videos de culinaria frequentemente ensinam varias receitas seguidas.

Use TUDO o que o video oferece:
- o que a pessoa fala (a maior parte das quantidades costuma estar na fala);
- o texto escrito na tela (legendas, cartelas de ingredientes, listas sobrepostas);
- o que aparece na imagem (embalagens, utensilios, tamanho das panelas e formas,
  temperatura e tempo mostrados no forno ou no display do aparelho).

Se a fala e a tela discordarem, prefira o que estiver escrito na tela e registre a
divergencia em warnings.

Se vier uma legenda publicada junto com o video, use-a como reforco: ela costuma
trazer as quantidades por escrito. Quando a legenda e a fala discordarem, prefira a
legenda para quantidades e o video para o modo de preparo.

Marque em start_time o momento em que cada receita comeca — a hora em que a pessoa
anuncia o prato ou comeca a separar os ingredientes dele.

Se o video NAO ensinar receita nenhuma (for so uma degustacao, uma resenha de
restaurante ou um comentario), devolva "recipes": [].

${FORMATO}`;

const PROMPT_TEXTO = `Voce esta lendo o material de divulgacao de uma receita de
culinaria: pode ser a legenda de um post, a descricao de um video, o print de uma
tela ou a foto de uma receita escrita em papel.

Sua tarefa e transformar isso em receitas organizadas. O material pode trazer mais
de uma receita — separe todas.

Se o material NAO contiver receita de fato (so tiver link de afiliado, pedido de
inscricao no canal, hashtags, ou apenas o nome do prato sem o preparo), devolva
"recipes": [] e explique em warnings o que faltou.

Se houver ingredientes mas o modo de preparo estiver ausente, mantenha a receita na
lista, preencha o que existe e registre a falta em warnings.

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

// "12:34" ou "1:02:03" -> segundos
function emSegundos(t) {
  if (t === null || t === undefined) return null;
  const partes = String(t).trim().split(':').map(Number);
  if (!partes.length || partes.some(n => !Number.isFinite(n) || n < 0)) return null;
  const seg = partes.reduce((total, n) => total * 60 + n, 0);
  return seg > 0 ? Math.round(seg) : null;
}

function erro(msg, status = 500, diagnostico = null) {
  const e = new Error(msg);
  e.status = status;
  e.diagnostico = diagnostico;
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

// So o texto da mensagem de erro do Google. O corpo inteiro traz tambem um
// campo "status" (ex.: "UNAVAILABLE" em sobrecarga) que confundia a
// classificacao abaixo com "video indisponivel".
function mensagemErro(detalhe) {
  try { return JSON.parse(detalhe)?.error?.message || ''; } catch { return String(detalhe || ''); }
}

// Que tipo de falha foi — decide se vale insistir, trocar de modelo ou parar
function tipoErro(status, detalhe) {
  const msg = mensagemErro(detalhe);
  if (status === 429)                                        return 'cota';
  if (/API key/i.test(msg))                                  return 'chave';
  if (status === 404 || /model.*not found|not supported for/i.test(msg)) return 'modelo';
  if (status >= 500 || /overload|high demand|try again later/i.test(msg)) return 'sobrecarga';
  if (/private|age.?restrict|video (is )?(not available|unavailable)|not available in your/i.test(msg))
                                                             return 'video';
  return 'repetir';  // 400 intermitente do YouTube e afins
}

// Mensagem curta do erro devolvido pelo Google, para mostrar na tela
function resumoErro(status, detalhe) {
  let msg = '';
  try { msg = JSON.parse(detalhe)?.error?.message || ''; } catch { /* nao era JSON */ }
  msg = (msg || String(detalhe || '')).replace(/\s+/g, ' ').trim().slice(0, 140);
  return `Gemini ${status}${msg ? ': ' + msg : ''}`;
}

async function chamarGemini(apiKey, blocoVideo, textoExtra = null, prazo = Date.now() + 35_000) {
  // Estrategia de insistencia:
  //  - 400 intermitente (comum com links do YouTube): repete no mesmo modelo,
  //    primeiro sem o ajuste de frames, depois apos uma pausa;
  //  - sobrecarga (503): troca de modelo na hora — cada um tem capacidade
  //    propria no Google; se todos estiverem cheios, respira e tenta outra rodada;
  //  - cota, chave invalida ou video inacessivel: para na hora.
  // "prazo" e o horario-limite para COMECAR uma tentativa (a Vercel corta aos 60s).

  const semAjuste = { ...blocoVideo };
  delete semAjuste.processing;

  const roteiro = [
    { bloco: blocoVideo, pausa: 0 },
    { bloco: semAjuste,  pausa: 0 },
    { bloco: semAjuste,  pausa: 2000 }
  ];

  const vistos = [];      // todos os erros, para escolher o mais informativo
  let tentativas = 0;

  rodadas:
  for (let rodada = 0; rodada < 2; rodada++) {
    let sobrecargaNaRodada = false;

    modelos:
    for (const modelo of MODELOS_GEMINI) {
      for (const passo of roteiro) {
        if (Date.now() > prazo) break rodadas;
        if (passo.pausa) await new Promise(r => setTimeout(r, passo.pausa));

        tentativas++;
        const res = await fetch(`${GEMINI_BASE}/v1beta/interactions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({
            model: modelo,
            input: [
              passo.bloco,
              ...(textoExtra
                ? [{ type: 'text', text: `LEGENDA PUBLICADA JUNTO COM O VIDEO:\n\n${textoExtra}` }]
                : []),
              { type: 'text', text: PROMPT_VIDEO }
            ]
          })
        });

        if (res.ok) {
          const texto = textoDaInteracao(await res.json());
          if (texto) {
            try { return lerJson(texto, 'gemini'); }
            catch { vistos.push({ status: 200, detalhe: 'resposta fora do formato esperado', modelo, tipo: 'repetir' }); continue; }
          }
          vistos.push({ status: 200, detalhe: 'resposta vazia', modelo, tipo: 'repetir' });
          continue;
        }

        const detalhe = await res.text();
        const tipo = tipoErro(res.status, detalhe);
        console.error(`[gemini ${modelo} tentativa ${tentativas}] ${res.status} ${tipo}`, detalhe.slice(0, 300));
        vistos.push({ status: res.status, detalhe, modelo, tipo });

        if (tipo === 'cota' || tipo === 'chave' || tipo === 'video') break rodadas;
        if (tipo === 'sobrecarga') { sobrecargaNaRodada = true; continue modelos; }
        if (tipo === 'modelo') continue modelos;
        // 'repetir': segue o roteiro no mesmo modelo
      }
    }

    // Todos cheios: respira e passa a lista mais uma vez, se der tempo
    if (sobrecargaNaRodada && Date.now() + 3000 < prazo) {
      await new Promise(r => setTimeout(r, 3000));
      continue rodadas;
    }
    break rodadas;
  }

  // O erro mais informativo, nao simplesmente o ultimo: um 404 do ultimo modelo
  // da lista nao pode esconder a sobrecarga que aconteceu nos anteriores
  const prioridade = ['cota', 'chave', 'video', 'sobrecarga', 'repetir', 'modelo'];
  const principal = prioridade
    .map(t => vistos.filter(e => e.tipo === t).at(-1))
    .find(Boolean) || null;

  const diag = principal
    ? `${resumoErro(principal.status, principal.detalhe)} (${tentativas} tentativa${tentativas > 1 ? 's' : ''})`
    : null;

  switch (principal?.tipo) {
    case 'cota':
      throw erro('O limite gratuito do Gemini foi atingido por hoje. Tente amanha ou use o print da tela.', 429, diag);
    case 'chave':
      throw erro('A GEMINI_API_KEY parece invalida. Confira a chave na Vercel.', 400, diag);
    case 'video':
      throw erro('Esse video nao esta acessivel para o Gemini (privado, restrito por idade ou indisponivel).', 422, diag);
    case 'sobrecarga':
      throw erro('Os servidores do Gemini estao sobrecarregados agora. Tente de novo em alguns minutos.', 503, diag);
    default:
      throw erro('O Gemini nao conseguiu processar esse video, mesmo tentando de novo.', 502, diag);
  }
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

  // Nenhuma nova tentativa no Gemini depois de 38s: a Vercel corta aos 60s
  const PRAZO = Date.now() + 38_000;

  try {
    const { url, videoUrl, mimeType, text, fileData, mediaType,
            caption, sourceUrl, sourceType, author } = req.body || {};

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
      }, null, PRAZO);

    // ── CAMINHO 2: arquivo de video enviado pelo usuario (reel, TikTok, celular) ──
    } else if (videoUrl) {
      if (!chaveGemini) {
        return res.status(500).json({ error: 'GEMINI_API_KEY nao configurada na Vercel.' });
      }

      const baixado = await fetch(videoUrl);
      if (!baixado.ok) {
        throw erro('Nao consegui baixar o video para o Gemini assistir.', 502,
                   `download do video: HTTP ${baixado.status}`);
      }
      const bytes = Buffer.from(await baixado.arrayBuffer());

      if (bytes.length > 95 * 1024 * 1024) {
        throw erro('Video grande demais (limite de 95 MB).', 413);
      }

      let mime = (mimeType || baixado.headers.get('content-type') || 'video/mp4').split(';')[0];
      if (!mime.startsWith('video/')) mime = 'video/mp4';

      origem.source_type = sourceType || 'video';
      origem.source_url  = sourceUrl || null;
      origem.author      = author || null;

      // Ate 14 MB o video vai dentro da propria requisicao (o base64 cresce um
      // terco e o limite do Google e 20 MB). Reels quase sempre cabem, e assim
      // pulamos o envio separado e a espera de processamento, que podiam levar
      // 40 segundos e estourar o limite da Vercel.
      if (bytes.length <= 14 * 1024 * 1024) {
        bruto = await chamarGemini(chaveGemini, {
          type: 'video', data: bytes.toString('base64'), mime_type: mime,
          processing: { type: 'static', fps: 0.25 }
        }, caption || null, PRAZO);
      } else {
        const arquivo = await subirVideoGemini(chaveGemini, bytes, mime);
        try {
          bruto = await chamarGemini(chaveGemini, {
            type: 'video', uri: arquivo.uri, mime_type: arquivo.mime,
            processing: { type: 'static', fps: 0.25 }
          }, caption || null, PRAZO);
        } finally {
          await apagarArquivoGemini(chaveGemini, arquivo.name);
        }
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
          found: false, count: 0, recipes: [], ...origem,
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

    // Aceita tanto a lista nova quanto uma receita solta, por seguranca
    const cruas = Array.isArray(bruto.recipes) ? bruto.recipes
                : (bruto.title || bruto.ingredients ? [bruto] : []);

    const receitas = cruas.map(r => {
      const ingredients = lista(r.ingredients);
      const steps       = lista(r.steps);
      const tempo       = Number(r.total_time_min);
      return {
        title:          r.title || origem.title || 'Receita sem nome',
        category:       CATEGORIAS.includes(r.category) ? r.category : 'Outros',
        tags:           lista(r.tags).slice(0, 5).map(t => t.toLowerCase()),
        servings:       r.servings || null,
        total_time_min: Number.isFinite(tempo) && tempo > 0 ? Math.round(tempo) : null,
        start_sec:      emSegundos(r.start_time),
        ingredients,
        steps,
        notes:          r.notes || null
      };
    }).filter(r => r.ingredients.length > 0 || r.steps.length > 0);

    return res.status(200).json({
      found:          receitas.length > 0,
      count:          receitas.length,
      recipes:        receitas,
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
      error: err.message || 'Erro interno ao ler a receita',
      diagnostico: err.diagnostico || null
    });
  }
}
