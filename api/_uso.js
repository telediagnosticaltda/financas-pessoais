// api/_uso.js
// Medidor de consumo de IA. (Comeca com "_": nao conta como funcao da Vercel.)
//
// Cada chamada ao Claude ou ao Gemini grava uma linha em `uso_ia` com os tokens e o custo estimado
// em dolar. O painel do app soma essas linhas (mais o custo das aulas do Cursos, que ja fica em
// curso_aulas.custo_usd) e compara com o limite mensal definido pelo medico.
//
// IMPORTANTE: registrar o uso NUNCA pode atrapalhar a funcao que o chamou. Qualquer falha aqui
// (tabela ainda nao criada, rede, token) e apenas registrada no log e ignorada.
//
// PRECOS: valores publicados pelos provedores (US$ por milhao de tokens). Se mudarem, e so editar aqui.

const PRECOS_CLAUDE = {
  'claude-sonnet-4-6':          { entrada: 3, saida: 15, escrita: 3.75, leitura: 0.30 },
  'claude-haiku-4-5-20251001':  { entrada: 1, saida: 5,  escrita: 1.25, leitura: 0.10 }
};
// Gemini 3.x Flash: preco de lancamento ate 31/12/2026; dobra em 1/1/2027.
// Audio: valor ASSUMIDO (2x o texto), porque o preco do audio de entrada deste modelo nao foi confirmado.
const GEMINI_ATE_2026 = { entrada: 0.75, saida: 3.75, audio: 1.5 };
const GEMINI_DOBRA_EM = Date.UTC(2027, 0, 1);
const TOKENS_POR_SEGUNDO_AUDIO = 25;

export function precoGemini(agora = Date.now()) {
  const f = agora >= GEMINI_DOBRA_EM ? 2 : 1;
  return { entrada: GEMINI_ATE_2026.entrada * f, saida: GEMINI_ATE_2026.saida * f, audio: GEMINI_ATE_2026.audio * f };
}

// Custo em US$ de uma chamada. `saida` do Gemini ja deve incluir os tokens de raciocinio.
export function calcularCusto(d, agora = Date.now()) {
  const modelo = String(d.modelo || '');
  const n = (v) => Math.max(0, Number(v) || 0);
  let custo = 0;
  if (modelo.startsWith('claude')) {
    const p = PRECOS_CLAUDE[modelo] || PRECOS_CLAUDE['claude-sonnet-4-6'];
    custo = (n(d.entrada) * p.entrada + n(d.saida) * p.saida + n(d.cacheEscrita) * p.escrita + n(d.cacheLeitura) * p.leitura) / 1e6;
  } else if (modelo.startsWith('gemini')) {
    const p = precoGemini(agora);
    const tokensAudio = Math.round(n(d.audioSeg) * TOKENS_POR_SEGUNDO_AUDIO);
    const tokensTexto = Math.max(0, n(d.entrada) - tokensAudio);
    custo = (tokensTexto * p.entrada + tokensAudio * p.audio + n(d.saida) * p.saida) / 1e6;
  }
  return Math.round(custo * 1e6) / 1e6;
}

// Uso informado pela resposta do Claude
export function usoDoClaude(data) {
  const u = (data && data.usage) || {};
  return {
    entrada: Number(u.input_tokens) || 0,
    saida: Number(u.output_tokens) || 0,
    cacheLeitura: Number(u.cache_read_input_tokens) || 0,
    cacheEscrita: Number(u.cache_creation_input_tokens) || 0,
    estimado: false
  };
}

// Uso informado pela resposta do Gemini ("interactions"). Os nomes dos campos ja mudaram algumas vezes:
// procura as variacoes conhecidas. Se nada for informado, estima pelo tamanho do texto (e marca como estimado).
export function usoDoGemini(dados, estimativa = {}) {
  const inter = (dados && (dados.interaction || dados)) || {};
  const u = inter.usage || inter.usage_metadata || inter.usageMetadata || {};
  const n = (...chaves) => { for (const c of chaves) if (typeof u[c] === 'number') return u[c]; return 0; };
  const entrada = n('total_input_tokens', 'input_tokens', 'prompt_token_count', 'promptTokenCount') + n('total_tool_use_tokens', 'tool_use_prompt_token_count', 'toolUsePromptTokenCount');
  const saida = n('total_output_tokens', 'output_tokens', 'candidates_token_count', 'candidatesTokenCount')
              + n('total_thought_tokens', 'thoughts_token_count', 'thoughtsTokenCount');
  if (entrada || saida) return { entrada, saida, cacheLeitura: 0, cacheEscrita: 0, estimado: false };
  const porChars = (c) => Math.ceil((Number(c) || 0) / 3.2);
  return { entrada: porChars(estimativa.entradaChars) + (Number(estimativa.extraTokens) || 0), saida: porChars(estimativa.saidaChars), cacheLeitura: 0, cacheEscrita: 0, estimado: true };
}

export function montarLinha(d, agora = Date.now()) {
  return {
    funcao: String(d.funcao || 'outra').slice(0, 40),
    provedor: String(d.modelo || '').startsWith('claude') ? 'claude' : 'gemini',
    modelo: String(d.modelo || '').slice(0, 80),
    tokens_entrada: Math.round(Number(d.entrada) || 0),
    tokens_saida: Math.round(Number(d.saida) || 0),
    tokens_cache_leitura: Math.round(Number(d.cacheLeitura) || 0),
    tokens_cache_escrita: Math.round(Number(d.cacheEscrita) || 0),
    audio_segundos: Math.round((Number(d.audioSeg) || 0) * 10) / 10,
    custo_usd: calcularCusto(d, agora),
    estimado: !!d.estimado
  };
}

// Grava uma linha em uso_ia, com a sessao do proprio medico (mesmas regras de acesso das demais tabelas).
// Nunca lanca erro.
export async function registrarUso(req, d) {
  try {
    const base = process.env.SUPABASE_URL, chave = process.env.SUPABASE_KEY;
    const autorizacao = String((req && req.headers && req.headers.authorization) || '');
    if (!base || !chave || !/^Bearer /.test(autorizacao)) return false;
    const controle = new AbortController();
    const timer = setTimeout(() => controle.abort(), 2500);
    try {
      const r = await fetch(`${base}/rest/v1/uso_ia`, {
        method: 'POST',
        headers: { apikey: chave, Authorization: autorizacao, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify(montarLinha(d)),
        signal: controle.signal
      });
      if (!r.ok) { console.error('[uso] nao registrei:', r.status); return false; }
      return true;
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    console.error('[uso] nao registrei:', (e && e.message) || e);
    return false;
  }
}
