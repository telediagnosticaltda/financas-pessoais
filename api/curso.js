import { requireAuth } from './_auth.js';

// api/curso.js
// Aba "Cursos" (fase de teste): toca aulas guardadas no Google Drive e manda
// o video para o Gemini assistir (audio + slides).
//
// O navegador chama esta funcao varias vezes, uma "acao" por vez, porque a
// Vercel corta cada chamada aos 60s. Nenhuma acao demora mais que alguns segundos:
//   token           -> chave temporaria (1h) do Drive, para o player tocar o video
//   info            -> nome, tamanho e tipo do arquivo no Drive
//   iniciar-envio   -> abre o envio do video para a area de arquivos do Gemini
//   enviar-parte    -> copia um pedaco do video, do Drive direto para o Gemini
//   estado-arquivo  -> o Gemini ja terminou de preparar o video?
//   analisar        -> pede a analise da aula (roda em segundo plano no Google)
//   resultado       -> a analise ficou pronta?
//   apagar          -> apaga o video da area temporaria do Gemini
//
// O video vai do Drive para o Gemini passando so pelos servidores (Vercel e
// Google): nao usa a internet da sua casa e a chave do Gemini nunca sai daqui.
//
// Variaveis de ambiente: GEMINI_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
// SUPABASE_URL, SUPABASE_KEY

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_KEY;

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';
const DRIVE_BASE  = 'https://www.googleapis.com/drive/v3';

const MODELOS_GEMINI = ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash'];

// Pedaco copiado por chamada. Precisa ser multiplo de 256 KB (exigencia do
// envio em partes do Google). 32 MB cabe com folga nos 60s da Vercel.
const PEDACO = 32 * 1024 * 1024;

const TEMAS = [
  'Ombro', 'Cotovelo', 'Punho e mão', 'Quadril e pelve', 'Joelho',
  'Tornozelo e pé', 'Coluna',
  'Trauma e fraturas', 'Tumores ósseos e de partes moles',
  'Artropatias e reumatologia', 'Infecção', 'Doenças ósseas metabólicas',
  'Musculoesquelético pediátrico', 'Técnica e física (RM/US/TC)'
];

const PROMPT_AULA = `Voce esta analisando uma videoaula de um curso de RADIOLOGIA MUSCULOESQUELETICA, em portugues do Brasil, para um medico radiologista que vai estudar e pesquisar o conteudo depois.

Assista ao video inteiro, ouvindo o audio E lendo o que aparece na tela (slides, legendas de imagens, setas, nomes escritos nos casos).

Regras importantes:
- Transcreva a fala com fidelidade, em portugues, sem resumir. Corrija apenas erros evidentes de fala.
- Escreva corretamente a terminologia medica, epônimos e siglas (ex.: Segond, Hill-Sachs, Bankart, Stener, LCA, LCU, STIR, DP, T1, T2). Use o texto dos slides para confirmar a grafia.
- Divida a transcricao em trechos curtos (uma ou duas frases, de 10 a 40 segundos cada), cada um com o tempo de inicio.
- Tempos no formato MM:SS, ou H:MM:SS se o video passar de uma hora. Os tempos precisam corresponder ao momento real do video.
- Em "slides", registre cada slide diferente (ou mudanca importante na tela) com o tempo em que aparece e o texto escrito nele. Se o slide so tem imagem, descreva em poucas palavras o que mostra (modalidade, sequencia, regiao, achado indicado).
- Em "topicos", liste as grandes partes da aula com o tempo de inicio.
- Em "temas", escolha UM OU MAIS da lista abaixo que a aula realmente aborda (nao invente temas fora da lista):
${TEMAS.map(t => '  - ' + t).join('\n')}

Responda SOMENTE com um JSON valido, sem texto antes ou depois e sem crases, neste formato:
{
  "titulo": "titulo curto da aula",
  "resumo": "resumo de 3 a 6 frases do conteudo",
  "temas": ["..."],
  "topicos": [{ "inicio": "00:00", "titulo": "..." }],
  "slides": [{ "inicio": "00:00", "texto": "..." }],
  "transcricao": [{ "inicio": "00:00", "texto": "..." }]
}`;

// Preco do Gemini Flash no plano pago, em US$ por milhao de tokens.
// Valido ate 31/12/2026; a partir de 2027 o Google dobra esses valores.
const PRECO_ENTRADA = 0.75;
const PRECO_SAIDA   = 3.75;

// ─────────────────────────────────────────────────────────────
// Utilidades
// ─────────────────────────────────────────────────────────────
function erro(msg, status = 500, extra = null) {
  const e = new Error(msg);
  e.status = status;
  if (extra) e.extra = extra;
  return e;
}

async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }
  });
  return r.json();
}

// Mesmo login Google do Gmail (agora com permissao de leitura do Drive)
async function tokenGoogle() {
  const [linha] = await sbGet('app_tokens?key=eq.gmail_refresh_token&select=value');
  if (!linha?.value) {
    throw erro('A conta Google ainda nao foi autorizada. Va em Configuracoes > Autorizar Google.', 403);
  }
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: linha.value,
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type:    'refresh_token'
    })
  });
  const d = await r.json();
  if (!d.access_token) {
    console.error('[curso token]', d);
    throw erro('Nao consegui renovar o acesso ao Google. Autorize de novo em Configuracoes.', 403);
  }
  const escopos = d.scope || '';
  return { token: d.access_token, expira: d.expires_in || 3600, temDrive: /drive/.test(escopos), escopos };
}

async function exigirDrive() {
  const g = await tokenGoogle();
  if (!g.temDrive) {
    throw erro('A autorizacao do Google ainda nao inclui o Drive. Va em Configuracoes e clique em "Autorizar Google" de novo.', 403);
  }
  return g;
}

function validarId(id) {
  if (!id || !/^[A-Za-z0-9_-]{10,}$/.test(id)) throw erro('Link do Drive invalido.', 400);
  return id;
}

async function infoDrive(token, id) {
  const r = await fetch(
    `${DRIVE_BASE}/files/${id}?fields=id,name,size,mimeType,videoMediaMetadata&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (r.status === 404) throw erro('Arquivo nao encontrado no seu Drive. Confira o link.', 404);
  if (!r.ok) {
    const t = await r.text();
    console.error('[curso info]', r.status, t.slice(0, 300));
    if (r.status === 403 && /has not been used|disabled/i.test(t)) {
      throw erro('A API do Google Drive nao esta ativada no projeto do Google Cloud.', 403);
    }
    throw erro(`O Drive recusou o acesso ao arquivo (${r.status}).`, 502);
  }
  return r.json();
}

function mensagemGoogle(detalhe) {
  try { return JSON.parse(detalhe)?.error?.message || ''; } catch { return String(detalhe || ''); }
}

function textoDaInteracao(inter) {
  let saida = '';
  for (const passo of inter.steps || []) {
    if (passo.type && passo.type !== 'model_output') continue;
    for (const bloco of passo.content || []) {
      if (bloco.type === 'text' && bloco.text) saida += bloco.text + '\n';
    }
  }
  if (!saida && inter.output_text) saida = inter.output_text;
  if (!saida && Array.isArray(inter.outputs)) {
    saida = inter.outputs.map(o => o.text || '').join('\n');
  }
  return saida.trim();
}

function lerJson(texto) {
  let t = texto.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const ini = t.indexOf('{');
  const fim = t.lastIndexOf('}');
  if (ini >= 0 && fim > ini) t = t.slice(ini, fim + 1);
  return JSON.parse(t);
}

// Contagem de tokens: o Google ja mudou os nomes desses campos algumas vezes,
// entao procura pelas variacoes conhecidas.
function resumirUso(inter) {
  const u = inter.usage || inter.usage_metadata || inter.usageMetadata || {};
  const n = (...chaves) => {
    for (const c of chaves) if (typeof u[c] === 'number') return u[c];
    return 0;
  };
  const entrada    = n('total_input_tokens', 'input_tokens', 'prompt_token_count', 'promptTokenCount');
  const ferramenta = n('total_tool_use_tokens', 'tool_use_prompt_token_count', 'toolUsePromptTokenCount');
  const saida      = n('total_output_tokens', 'output_tokens', 'candidates_token_count', 'candidatesTokenCount');
  const raciocinio = n('total_thought_tokens', 'thoughts_token_count', 'thoughtsTokenCount');

  const custo = ((entrada + ferramenta) * PRECO_ENTRADA + (saida + raciocinio) * PRECO_SAIDA) / 1e6;
  return { entrada, ferramenta, saida, raciocinio, custoUSD: Number(custo.toFixed(4)), bruto: u };
}

// ─────────────────────────────────────────────────────────────
// Acoes
// ─────────────────────────────────────────────────────────────
async function acaoToken() {
  const g = await exigirDrive();
  return { access_token: g.token, expires_in: g.expira };
}

async function acaoInfo({ id }) {
  validarId(id);
  const g = await exigirDrive();
  const f = await infoDrive(g.token, id);
  return {
    id: f.id,
    nome: f.name,
    tamanho: Number(f.size || 0),
    tipo: f.mimeType,
    duracaoMs: Number(f.videoMediaMetadata?.durationMillis || 0)
  };
}

async function acaoIniciarEnvio({ id }, chave) {
  validarId(id);
  const g = await exigirDrive();
  const f = await infoDrive(g.token, id);
  const tamanho = Number(f.size || 0);
  if (!tamanho) throw erro('Nao consegui ler o tamanho do video no Drive.', 422);
  if (!/^video\//.test(f.mimeType || '')) throw erro('Esse arquivo do Drive nao e um video.', 422);

  const inicio = await fetch(`${GEMINI_BASE}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': chave,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(tamanho),
      'X-Goog-Upload-Header-Content-Type': f.mimeType,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ file: { display_name: (f.name || 'aula').slice(0, 120) } })
  });

  const enderecoEnvio = inicio.headers.get('x-goog-upload-url');
  if (!inicio.ok || !enderecoEnvio) {
    const t = await inicio.text();
    console.error('[curso iniciar-envio]', inicio.status, t.slice(0, 300));
    throw erro(`O Gemini recusou o envio (${inicio.status}): ${mensagemGoogle(t).slice(0, 160)}`, 502);
  }

  return { enderecoEnvio, tamanho, tipo: f.mimeType, nome: f.name, pedaco: PEDACO };
}

async function acaoEnviarParte({ id, enderecoEnvio, offset, tamanho }) {
  validarId(id);
  offset  = Number(offset);
  tamanho = Number(tamanho);
  if (!enderecoEnvio || !/^https:\/\/[a-z0-9.-]+\.googleapis\.com\//.test(enderecoEnvio)) {
    throw erro('Endereco de envio invalido.', 400);
  }
  if (!(offset >= 0) || !(tamanho > 0) || offset >= tamanho) throw erro('Posicao de envio invalida.', 400);

  const g = await exigirDrive();
  const fim = Math.min(offset + PEDACO, tamanho) - 1;
  const ultimo = fim === tamanho - 1;

  // 1. Baixa o pedaco do Drive
  const rd = await fetch(`${DRIVE_BASE}/files/${id}?alt=media&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${g.token}`, Range: `bytes=${offset}-${fim}` }
  });
  if (!rd.ok) {
    const t = await rd.text();
    console.error('[curso drive parte]', rd.status, t.slice(0, 300));
    throw erro(`Falha ao ler o video no Drive (${rd.status}).`, 502);
  }
  const bytes = Buffer.from(await rd.arrayBuffer());
  const esperado = fim - offset + 1;
  if (bytes.length !== esperado) {
    throw erro(`O Drive devolveu um pedaco de tamanho inesperado (${bytes.length} de ${esperado}).`, 502);
  }

  // 2. Entrega o pedaco ao Gemini
  const re = await fetch(enderecoEnvio, {
    method: 'POST',
    headers: {
      'Content-Length': String(bytes.length),
      'X-Goog-Upload-Offset': String(offset),
      'X-Goog-Upload-Command': ultimo ? 'upload, finalize' : 'upload'
    },
    body: bytes
  });
  if (!re.ok) {
    const t = await re.text();
    console.error('[curso gemini parte]', re.status, t.slice(0, 300));
    throw erro(`O Gemini recusou um pedaco do video (${re.status}).`, 502);
  }

  if (!ultimo) return { offset: fim + 1, terminou: false };

  const arquivo = (await re.json())?.file;
  if (!arquivo?.name) throw erro('O Gemini nao confirmou o recebimento do video.', 502);
  return {
    offset: tamanho,
    terminou: true,
    arquivo: { nome: arquivo.name, uri: arquivo.uri, tipo: arquivo.mimeType, estado: arquivo.state }
  };
}

async function acaoEstadoArquivo({ nome }, chave) {
  if (!/^files\/[A-Za-z0-9_-]+$/.test(nome || '')) throw erro('Arquivo invalido.', 400);
  const r = await fetch(`${GEMINI_BASE}/v1beta/${nome}`, { headers: { 'x-goog-api-key': chave } });
  if (!r.ok) throw erro(`Nao consegui consultar o video no Gemini (${r.status}).`, 502);
  const d = await r.json();
  return { estado: d.state, uri: d.uri, tipo: d.mimeType };
}

async function acaoAnalisar({ uri, tipo }, chave) {
  if (!/^https:\/\/generativelanguage\.googleapis\.com\//.test(uri || '')) throw erro('Video invalido.', 400);

  // Um quadro a cada 5 segundos basta para ler os slides (mudam devagar) e
  // reduz bastante o custo. Se o Google recusar algum ajuste, tenta sem ele.
  const variacoes = [
    { processing: { type: 'static', fps: 0.2 }, media_resolution: 'high' },
    { processing: { type: 'static', fps: 0.2 } },
    {}
  ];

  const vistos = [];
  for (const modelo of MODELOS_GEMINI) {
    for (const ajuste of variacoes) {
      const res = await fetch(`${GEMINI_BASE}/v1beta/interactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': chave },
        body: JSON.stringify({
          model: modelo,
          background: true,
          input: [
            { type: 'video', uri, mime_type: tipo || 'video/mp4', ...ajuste },
            { type: 'text', text: PROMPT_AULA }
          ]
        })
      });

      const texto = await res.text();
      if (res.ok) {
        let d = {};
        try { d = JSON.parse(texto); } catch { /* segue */ }
        const inter = d.interaction || d;
        if (inter.id) return { id: inter.id, modelo, ajuste: Object.keys(ajuste).join('+') || 'padrao' };
        vistos.push(`${modelo}: resposta sem id`);
        continue;
      }

      const msg = mensagemGoogle(texto).slice(0, 200);
      vistos.push(`${modelo} ${res.status}: ${msg}`);
      console.error('[curso analisar]', modelo, res.status, msg);

      if (res.status === 400) continue;                       // tenta sem o ajuste
      if (res.status === 404 || res.status >= 500) break;      // proximo modelo
      if (res.status === 429) throw erro('Limite de uso do Gemini atingido. Tente de novo em alguns minutos.', 429);
      if (res.status === 401 || res.status === 403) throw erro('A chave do Gemini foi recusada. Confira a GEMINI_API_KEY na Vercel.', 403);
      break;
    }
  }
  throw erro('O Gemini nao aceitou analisar o video.', 502, vistos);
}

async function acaoResultado({ id }, chave) {
  if (!/^[A-Za-z0-9_.\/-]+$/.test(id || '')) throw erro('Analise invalida.', 400);
  const caminho = id.startsWith('interactions/') ? id : `interactions/${id}`;
  const r = await fetch(`${GEMINI_BASE}/v1beta/${caminho}`, { headers: { 'x-goog-api-key': chave } });
  const texto = await r.text();
  if (!r.ok) {
    console.error('[curso resultado]', r.status, texto.slice(0, 300));
    throw erro(`Nao consegui consultar a analise (${r.status}).`, 502);
  }
  const d = JSON.parse(texto);
  const inter = d.interaction || d;
  const status = String(inter.status || '').toLowerCase();

  if (['in_progress', 'queued', 'pending', 'running'].includes(status)) {
    return { pronto: false, status };
  }
  if (['failed', 'cancelled', 'canceled', 'error'].includes(status)) {
    const motivo = inter.error?.message || inter.status_message || status;
    throw erro(`O Gemini nao conseguiu terminar a analise: ${motivo}`, 502);
  }

  const saida = textoDaInteracao(inter);
  if (!saida) return { pronto: false, status: status || 'sem_saida' };

  const uso = resumirUso(inter);
  let dados;
  try {
    dados = lerJson(saida);
  } catch {
    // Devolve o texto cru para nao perder a analise ja paga
    return { pronto: true, uso, dados: null, textoCru: saida.slice(0, 200_000) };
  }
  return { pronto: true, uso, dados };
}

async function acaoApagar({ nome }, chave) {
  if (!/^files\/[A-Za-z0-9_-]+$/.test(nome || '')) return { ok: false };
  try {
    await fetch(`${GEMINI_BASE}/v1beta/${nome}`, { method: 'DELETE', headers: { 'x-goog-api-key': chave } });
  } catch { /* os arquivos expiram sozinhos em cerca de 48h */ }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Metodo nao permitido' }); return; }
  if (!(await requireAuth(req, res))) return;

  const corpo = req.body || {};
  const chave = process.env.GEMINI_API_KEY;

  try {
    let saida;
    switch (corpo.acao) {
      case 'token':          saida = await acaoToken(); break;
      case 'info':           saida = await acaoInfo(corpo); break;
      case 'enviar-parte':   saida = await acaoEnviarParte(corpo); break;
      case 'iniciar-envio':
      case 'estado-arquivo':
      case 'analisar':
      case 'resultado':
      case 'apagar': {
        if (!chave) throw erro('GEMINI_API_KEY nao configurada na Vercel.', 500);
        const mapa = {
          'iniciar-envio':  acaoIniciarEnvio,
          'estado-arquivo': acaoEstadoArquivo,
          'analisar':       acaoAnalisar,
          'resultado':      acaoResultado,
          'apagar':         acaoApagar
        };
        saida = await mapa[corpo.acao](corpo, chave);
        break;
      }
      default:
        throw erro('Acao desconhecida.', 400);
    }
    res.status(200).json(saida);
  } catch (e) {
    console.error('[curso]', corpo.acao, e.message, e.extra || '');
    res.status(e.status || 500).json({ error: e.message, detalhes: e.extra || undefined });
  }
}
