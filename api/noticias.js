// api/noticias.js
// Junta as manchetes dos principais portais para a tela inicial.
// O navegador não consegue ler os feeds (RSS) dos portais diretamente
// por uma trava de segurança da internet (CORS), então esta função faz isso.
//
// Para cada portal: tenta o feed oficial; se falhar, usa o Google Notícias
// filtrado pelo site do portal. Um portal fora do ar não derruba os outros.

import { requireAuth } from './_auth.js';

const FONTES = [
  { id: 'g1',      nome: 'g1',              site: 'g1.globo.com',
    feeds: ['https://g1.globo.com/rss/g1/'] },
  { id: 'folha',   nome: 'Folha',           site: 'folha.uol.com.br',
    feeds: ['https://feeds.folha.uol.com.br/emcimadahora/rss091.xml'] },
  { id: 'uol',     nome: 'UOL',             site: 'noticias.uol.com.br',
    feeds: ['https://rss.uol.com.br/feed/noticias.xml'] },
  { id: 'estadao', nome: 'Estadão',         site: 'estadao.com.br',  feeds: [] },
  { id: 'em',      nome: 'Estado de Minas', site: 'em.com.br',       feeds: [] },
];

const POR_FONTE = 8;
const TEMPO_LIMITE = 6000;          // 6 s por tentativa
const CACHE_TTL = 10 * 60 * 1000;   // guarda por 10 minutos
let cache = null;

const googleNews = (site) =>
  `https://news.google.com/rss/search?q=site:${site}+when:1d&hl=pt-BR&gl=BR&ceid=BR:pt-419`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  if (!(await requireAuth(req, res))) return;
  if (req.method !== 'GET') { res.status(405).json({ error: 'Método não permitido' }); return; }

  if (cache && Date.now() - cache.em < CACHE_TTL) {
    res.status(200).json(cache.dados);
    return;
  }

  const resultados = await Promise.all(FONTES.map(buscarFonte));

  const dados = {
    atualizado: new Date().toISOString(),
    fontes: FONTES.map((f, i) => ({ id: f.id, nome: f.nome, ok: resultados[i].length > 0 })),
    noticias: resultados.flat(),
  };

  // Só guarda em cache se pelo menos um portal respondeu
  if (dados.noticias.length) cache = { em: Date.now(), dados };

  res.status(200).json(dados);
}

async function buscarFonte(fonte) {
  const tentativas = [...fonte.feeds, googleNews(fonte.site)];
  for (const url of tentativas) {
    try {
      const xml = await baixar(url);
      const itens = lerItens(xml, url.includes('news.google.com'))
        .slice(0, POR_FONTE)
        .map(it => ({ ...it, fonte: fonte.nome, fonteId: fonte.id }));
      if (itens.length) return itens;
    } catch (err) {
      console.warn(`[noticias] ${fonte.id} falhou em ${url}:`, err.message);
    }
  }
  return [];
}

async function baixar(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TEMPO_LIMITE);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FinancasPessoais/1.0)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);

    // Alguns portais (Folha, UOL) ainda usam a codificação antiga ISO-8859-1
    const bytes = new Uint8Array(await r.arrayBuffer());
    const tipo = r.headers.get('content-type') || '';
    const inicio = new TextDecoder('latin1').decode(bytes.slice(0, 200));
    const charset =
      (tipo.match(/charset=([\w-]+)/i) || inicio.match(/encoding=["']([\w-]+)["']/i) || [])[1] || 'utf-8';
    try {
      return new TextDecoder(charset.toLowerCase()).decode(bytes);
    } catch {
      return new TextDecoder('utf-8').decode(bytes);
    }
  } finally {
    clearTimeout(timer);
  }
}

function lerItens(xml, ehGoogle) {
  const blocos = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  const itens = [];
  for (const b of blocos) {
    let titulo = limpar(tag(b, 'title'));
    const link = limpar(tag(b, 'link'));
    const data = limpar(tag(b, 'pubDate'));
    if (!titulo || !/^https?:\/\//i.test(link)) continue;

    // No Google Notícias o título vem como "Manchete - Nome do portal"
    if (ehGoogle) titulo = titulo.replace(/\s+-\s+[^-]+$/, '').trim();

    const quando = Date.parse(data);
    itens.push({
      titulo,
      link,
      data: Number.isNaN(quando) ? null : new Date(quando).toISOString(),
    });
  }
  return itens;
}

function tag(bloco, nome) {
  const m = bloco.match(new RegExp(`<${nome}(?:\\s[^>]*)?>([\\s\\S]*?)</${nome}>`, 'i'));
  return m ? m[1] : '';
}

function limpar(txt) {
  return txt
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
