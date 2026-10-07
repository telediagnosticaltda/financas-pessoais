// api/inicio.js
// Dados da tela inicial, numa função só (o plano gratuito da Vercel
// aceita no máximo 12 funções por projeto):
//   /api/inicio?tipo=noticias              → manchetes
//   /api/inicio?tipo=cotacoes&periodo=1d   → cotações com histórico para o gráfico
//
// Notícias: "Principais" vem do Google Notícias (ordenado por relevância).
// Cada portal mostra primeiro as matérias dele que estão entre as principais
// do Google, completando com as mais relevantes do dia naquele site.
//
// Cotações: Yahoo Finanças (cobre de 24 h até o histórico completo).
// Se falhar, usa o Banco Central (dólar) ou a CoinGecko (bitcoin).

import { requireAuth } from './_auth.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  if (!(await requireAuth(req, res))) return;
  if (req.method !== 'GET') { res.status(405).json({ error: 'Método não permitido' }); return; }

  const url = new URL(req.url, 'http://localhost');
  const tipo = url.searchParams.get('tipo');

  try {
    if (tipo === 'noticias') return res.status(200).json(await obterNoticias());
    if (tipo === 'cotacoes') {
      const periodo = url.searchParams.get('periodo') || '1d';
      if (!PERIODOS[periodo]) return res.status(400).json({ error: 'Período inválido' });
      return res.status(200).json(await obterCotacoes(periodo));
    }
    res.status(400).json({ error: 'Informe tipo=noticias ou tipo=cotacoes' });
  } catch (err) {
    console.error('[inicio]', err);
    res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────
// Utilidades
// ─────────────────────────────────────────────────────────────
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function baixar(url, { tempo = 7000, json = false } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), tempo);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, 'Accept': '*/*' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (json) return await r.json();

    // Alguns portais (Folha, UOL) ainda usam a codificação antiga ISO-8859-1
    const bytes = new Uint8Array(await r.arrayBuffer());
    const tipo = r.headers.get('content-type') || '';
    const inicio = new TextDecoder('latin1').decode(bytes.slice(0, 200));
    const charset =
      (tipo.match(/charset=([\w-]+)/i) || inicio.match(/encoding=["']([\w-]+)["']/i) || [])[1] || 'utf-8';
    try { return new TextDecoder(charset.toLowerCase()).decode(bytes); }
    catch { return new TextDecoder('utf-8').decode(bytes); }
  } finally {
    clearTimeout(timer);
  }
}

function entidades(t) {
  return t
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}
const semCdata = t => t.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
const texto = t => entidades(semCdata(t).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

function tag(bloco, nome) {
  const m = bloco.match(new RegExp(`<${nome}(?:\\s[^>]*)?>([\\s\\S]*?)</${nome}>`, 'i'));
  return m ? m[1] : '';
}

// ─────────────────────────────────────────────────────────────
// NOTÍCIAS
// ─────────────────────────────────────────────────────────────
const PORTAIS = [
  { id: 'g1',      nome: 'g1',              site: 'g1.globo.com',
    nomes: /^g1\b|globo/i,                 feed: 'https://g1.globo.com/rss/g1/' },
  { id: 'folha',   nome: 'Folha',           site: 'folha.uol.com.br',
    nomes: /folha/i,                       feed: 'https://feeds.folha.uol.com.br/emcimadahora/rss091.xml' },
  { id: 'uol',     nome: 'UOL',             site: 'noticias.uol.com.br',
    nomes: /^uol\b/i,                      feed: 'https://rss.uol.com.br/feed/noticias.xml' },
  { id: 'estadao', nome: 'Estadão',         site: 'estadao.com.br',
    nomes: /estad[ãa]o/i,                  feed: null },
  { id: 'em',      nome: 'Estado de Minas', site: 'em.com.br',
    nomes: /estado de minas/i,             feed: null },
];

const GOOGLE_PRINCIPAIS = 'https://news.google.com/rss?hl=pt-BR&gl=BR&ceid=BR:pt-419';
const googleSite = s =>
  `https://news.google.com/rss/search?q=site:${s}+when:1d&hl=pt-BR&gl=BR&ceid=BR:pt-419`;

// Páginas geradas automaticamente que não são notícia de verdade
const LIXO = new RegExp([
  'resultado das elei[çc][õo]es',
  'zona eleitoral',
  'se[çc][ãa]o eleitoral',
  'local de vota[çc][ãa]o',
  'resultado d[ao] (mega-?sena|lotof[áa]cil|quina|lotomania|timemania|dupla sena|dia de sorte|super sete|\\+milion[áa]ria|loteca|federal)',
  'concurso \\d+ d[ao] (mega-?sena|lotof[áa]cil|quina|lotomania|timemania)',
  'hor[óo]scopo',
].join('|'), 'i');

const POR_ABA = 10;
const TTL_NOTICIAS = 10 * 60 * 1000;
let cacheNoticias = null;

async function obterNoticias() {
  if (cacheNoticias && Date.now() - cacheNoticias.em < TTL_NOTICIAS) return cacheNoticias.dados;

  const [principais, ...porPortal] = await Promise.all([
    lerGooglePrincipais().catch(e => { console.warn('[noticias] principais:', e.message); return []; }),
    ...PORTAIS.map(p => lerPortal(p).catch(e => { console.warn(`[noticias] ${p.id}:`, e.message); return []; })),
  ]);

  const abas = [{
    id: 'principais', nome: 'Principais',
    itens: principais.slice(0, 20).map(({ titulo, link, fonte, data }) => ({ titulo, link, fonte, data })),
  }];

  PORTAIS.forEach((p, i) => {
    // 1º: matérias do portal que estão entre as principais do Google (mantém a ordem de relevância)
    const destaques = [];
    principais.forEach(n => {
      [n, ...n.cobertura].forEach(a => {
        if (p.nomes.test(a.fonte || '')) destaques.push({ ...a, fonte: p.nome, destaque: true });
      });
    });
    // 2º: completa com as mais relevantes do dia naquele site
    const vistos = new Set();
    const itens = [...destaques, ...porPortal[i].map(a => ({ ...a, fonte: p.nome }))]
      .filter(a => {
        const k = a.titulo.toLowerCase().slice(0, 60);
        if (vistos.has(k) || LIXO.test(a.titulo)) return false;
        vistos.add(k);
        return true;
      })
      .slice(0, POR_ABA);
    abas.push({ id: p.id, nome: p.nome, itens });
  });

  const dados = { atualizado: new Date().toISOString(), abas };
  if (abas.some(a => a.itens.length)) cacheNoticias = { em: Date.now(), dados };
  return dados;
}

// Principais do Google: cada item traz a matéria principal e, na descrição,
// a lista de outros veículos que cobriram o mesmo assunto.
async function lerGooglePrincipais() {
  const xml = await baixar(GOOGLE_PRINCIPAIS);
  const itens = [];
  for (const b of xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || []) {
    const fonte = texto(tag(b, 'source'));
    let titulo = texto(tag(b, 'title'));
    if (fonte && titulo.endsWith(' - ' + fonte)) titulo = titulo.slice(0, -(fonte.length + 3));
    else titulo = titulo.replace(/\s+-\s+[^-]+$/, '');
    const link = texto(tag(b, 'link'));
    if (!titulo || !/^https?:\/\//.test(link) || LIXO.test(titulo)) continue;

    const desc = entidades(semCdata(tag(b, 'description')));
    const cobertura = [];
    const re = /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>(?:[\s\S]*?<font[^>]*>([\s\S]*?)<\/font>)?/gi;
    let m;
    while ((m = re.exec(desc))) {
      const t = texto(m[2]), f = texto(m[3] || '');
      if (t && /^https?:\/\//.test(m[1]) && t !== titulo) cobertura.push({ titulo: t, link: m[1], fonte: f, data: null });
    }
    itens.push({ titulo, link, fonte, data: dataIso(texto(tag(b, 'pubDate'))), cobertura });
  }
  return itens;
}

// Mais relevantes do dia no site do portal; se o Google falhar, o feed do próprio portal
async function lerPortal(p) {
  const tentativas = [{ url: googleSite(p.site), google: true }];
  if (p.feed) tentativas.push({ url: p.feed, google: false });
  for (const t of tentativas) {
    try {
      const xml = await baixar(t.url);
      const itens = lerRss(xml, t.google).filter(a => !LIXO.test(a.titulo));
      if (itens.length) return itens.slice(0, 20);
    } catch (e) {
      console.warn(`[noticias] ${p.id} em ${t.url}:`, e.message);
    }
  }
  return [];
}

function lerRss(xml, ehGoogle) {
  const itens = [];
  for (const b of xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || []) {
    let titulo = texto(tag(b, 'title'));
    const link = texto(tag(b, 'link'));
    if (!titulo || !/^https?:\/\//i.test(link)) continue;
    if (ehGoogle) titulo = titulo.replace(/\s+-\s+[^-]+$/, '').trim();
    itens.push({ titulo, link, data: dataIso(texto(tag(b, 'pubDate'))) });
  }
  return itens;
}

function dataIso(s) {
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// ─────────────────────────────────────────────────────────────
// COTAÇÕES
// ─────────────────────────────────────────────────────────────
// janela24h: busca alguns dias e recorta as últimas 24 h disponíveis
const PERIODOS = {
  '1d':  { range: '5d',  interval: '5m',  janela24h: true, ttl: 3,  dias: 1 },
  '5d':  { range: '5d',  interval: '30m', ttl: 10, dias: 5 },
  '1m':  { range: '1mo', interval: '1h',  ttl: 30, dias: 30 },
  '6m':  { range: '6mo', interval: '1d',  ttl: 60, dias: 182 },
  'ytd': { range: 'ytd', interval: '1d',  ttl: 60, dias: null },
  '1a':  { range: '1y',  interval: '1d',  ttl: 60, dias: 365 },
  '5a':  { range: '5y',  interval: '1wk', ttl: 60 * 6, dias: 365 * 5 },
  'max': { range: 'max', interval: '1mo', ttl: 60 * 6, dias: null },
};

const ATIVOS = [
  { id: 'usd',    nome: 'Dólar',            moeda: 'BRL', yahoo: 'BRL=X'   },
  { id: 'btcbrl', nome: 'Bitcoin em reais', moeda: 'BRL', yahoo: 'BTC-BRL', gecko: 'brl' },
  { id: 'btcusd', nome: 'Bitcoin em dólar', moeda: 'USD', yahoo: 'BTC-USD', gecko: 'usd' },
];

const MAX_PONTOS = 300;
const cacheCot = new Map();

async function obterCotacoes(periodo) {
  const hit = cacheCot.get(periodo);
  const cfg = PERIODOS[periodo];
  if (hit && Date.now() - hit.em < cfg.ttl * 60 * 1000) return hit.dados;

  const ativos = await Promise.all(ATIVOS.map(a => serieAtivo(a, periodo)));
  const dados = { periodo, atualizado: new Date().toISOString(), ativos };
  if (ativos.some(a => a.pontos?.length)) cacheCot.set(periodo, { em: Date.now(), dados });
  return dados;
}

async function serieAtivo(ativo, periodo) {
  const base = { id: ativo.id, nome: ativo.nome, moeda: ativo.moeda };
  const fontes = [() => yahoo(ativo, periodo)];
  if (ativo.id === 'usd') fontes.push(() => bancoCentral(periodo));
  if (ativo.gecko)        fontes.push(() => coingecko(ativo.gecko, periodo));

  for (const f of fontes) {
    try {
      const r = await f();
      if (r.pontos.length >= 2) {
        const pontos = reduzir(r.pontos);
        const inicio = pontos[0][1];
        const preco = r.preco ?? pontos[pontos.length - 1][1];
        return {
          ...base, fonte: r.fonte, preco, inicio, pontos,
          variacao: inicio ? (preco / inicio - 1) * 100 : null,
        };
      }
    } catch (e) {
      console.warn(`[cotacoes] ${ativo.id} ${periodo}:`, e.message);
    }
  }
  return { ...base, pontos: [], erro: 'Histórico indisponível neste período' };
}

async function yahoo(ativo, periodo) {
  const cfg = PERIODOS[periodo];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ativo.yahoo)}` +
              `?range=${cfg.range}&interval=${cfg.interval}&includePrePost=false`;
  const j = await baixar(url, { json: true });
  const r = j?.chart?.result?.[0];
  if (!r?.timestamp) throw new Error('resposta vazia do Yahoo');
  const fech = r.indicators?.quote?.[0]?.close || [];
  let pontos = r.timestamp
    .map((t, i) => [t * 1000, fech[i]])
    .filter(p => p[1] != null && isFinite(p[1]));
  if (cfg.janela24h && pontos.length) {
    const fim = pontos[pontos.length - 1][0];
    pontos = pontos.filter(p => p[0] >= fim - 24 * 3600 * 1000);
  }
  const preco = r.meta?.regularMarketPrice;
  if (preco && pontos.length) pontos[pontos.length - 1] = [pontos[pontos.length - 1][0], preco];
  return { fonte: 'Yahoo Finanças', pontos, preco: preco ?? null };
}

// Reserva do dólar: PTAX diária do Banco Central (sem intraday, então só de 1 mês para cima)
async function bancoCentral(periodo) {
  if (periodo === '1d' || periodo === '5d') throw new Error('BCB não tem dados intraday');
  const hoje = new Date();
  const ini = inicioPeriodo(periodo, hoje, 10 * 365); // a API do BCB limita a 10 anos por consulta
  const fmt = d => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  const url = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.1/dados?formato=json&dataInicial=${fmt(ini)}&dataFinal=${fmt(hoje)}`;
  const lista = await baixar(url, { json: true });
  const pontos = (lista || []).map(x => {
    const [d, m, a] = x.data.split('/');
    return [Date.UTC(+a, +m - 1, +d, 15), parseFloat(x.valor)];
  }).filter(p => isFinite(p[1]));
  return { fonte: 'Banco Central (PTAX)', pontos, preco: null };
}

// Reserva do bitcoin: CoinGecko (gratuito limita o histórico a 365 dias)
async function coingecko(moeda, periodo) {
  const hoje = new Date();
  let dias = PERIODOS[periodo].dias;
  if (periodo === 'ytd') dias = Math.max(1, Math.ceil((hoje - new Date(hoje.getFullYear(), 0, 1)) / 86400000));
  if (!dias || dias > 365) throw new Error('CoinGecko gratuito só cobre até 1 ano');
  const url = `https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=${moeda}&days=${dias}`;
  const j = await baixar(url, { json: true });
  const pontos = (j?.prices || []).filter(p => isFinite(p[1]));
  return { fonte: 'CoinGecko', pontos, preco: null };
}

function inicioPeriodo(periodo, hoje, maxDias) {
  if (periodo === 'ytd') return new Date(hoje.getFullYear(), 0, 1);
  const dias = PERIODOS[periodo].dias ?? maxDias;
  return new Date(hoje.getTime() - Math.min(dias, maxDias) * 86400000);
}

// Reduz a série para no máximo MAX_PONTOS, mantendo o primeiro e o último
function reduzir(pontos) {
  if (pontos.length <= MAX_PONTOS) return pontos;
  const passo = (pontos.length - 1) / (MAX_PONTOS - 1);
  const out = [];
  for (let i = 0; i < MAX_PONTOS; i++) out.push(pontos[Math.round(i * passo)]);
  return out;
}
