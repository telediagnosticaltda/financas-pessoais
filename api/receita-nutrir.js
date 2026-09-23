import { requireAuth } from './_auth.js';

// api/receita-nutrir.js
// Estima calorias e proteina por porcao a partir da lista de ingredientes.
// Usada para as receitas que ja estavam salvas antes desse recurso existir —
// as novas ja saem estimadas pela /api/receita-extrair.
//
// Variavel de ambiente: ANTHROPIC_API_KEY

const MODELO = 'claude-sonnet-4-6';
const LOTE_MAX = 25;

const PROMPT = `Voce recebe uma lista de receitas com seus ingredientes. Para cada
uma, estime o valor nutricional POR PORCAO.

Responda APENAS com um objeto JSON, sem markdown, sem crases, sem texto em volta:

{
  "resultados": [
    {
      "id": "o mesmo id que veio na receita",
      "kcal_porcao": numero inteiro de calorias por porcao, ou null,
      "proteina_g": numero inteiro de gramas de proteina por porcao, ou null,
      "confianca": "alta" | "media" | "baixa"
    }
  ]
}

Como estimar:
- Use valores nutricionais tipicos dos alimentos brasileiros.
- Se o campo "porcoes" vier preenchido, divida o total por ele. Se vier vazio,
  suponha um numero razoavel de porcoes pelo volume dos ingredientes e marque
  "confianca": "baixa".
- Quantidades vagas ("um fio de azeite", "queijo a gosto", "creme de leite")
  puxam a confianca para baixo. Seja realista: "media" e o normal, "alta" so
  quando quase todos os ingredientes tem quantidade explicita.
- Ingredientes de guarnicao que nao fazem parte da receita (arroz para acompanhar,
  pao para servir) ficam de fora da conta.
- Se a receita nao tiver ingredientes suficientes para estimar, devolva null nos
  dois numeros e "confianca": "baixa".
- Devolva um resultado para CADA receita recebida, na mesma ordem, com o mesmo id.
- Nao explique nada. Nao escreva texto fora do JSON.`;

export default async function handler(req, res) {
  if (!(await requireAuth(req, res))) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY nao configurada' });

  try {
    const entrada = (req.body || {}).receitas;
    if (!Array.isArray(entrada) || !entrada.length) {
      return res.status(400).json({ error: 'Envie a lista de receitas' });
    }
    if (entrada.length > LOTE_MAX) {
      return res.status(400).json({ error: `Maximo de ${LOTE_MAX} receitas por vez` });
    }

    const enxuto = entrada.map(r => ({
      id: String(r.id),
      titulo: String(r.title || '').slice(0, 120),
      porcoes: r.servings || null,
      ingredientes: (Array.isArray(r.ingredients) ? r.ingredients : []).slice(0, 40)
    }));

    const resposta = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODELO,
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: `RECEITAS:\n\n${JSON.stringify(enxuto, null, 1)}` },
            { type: 'text', text: PROMPT }
          ]
        }]
      })
    });

    if (!resposta.ok) {
      console.error('[nutrir] claude', resposta.status, (await resposta.text()).slice(0, 300));
      return res.status(502).json({ error: 'A Claude API recusou a requisicao' });
    }

    const data = await resposta.json();
    const texto = (data.content || [])
      .filter(b => b.type === 'text').map(b => b.text).join('\n')
      .replace(/```json/gi, '').replace(/```/g, '').trim();

    let bruto;
    try {
      bruto = JSON.parse(texto);
    } catch {
      console.error('[nutrir] resposta nao era JSON:', texto.slice(0, 300));
      return res.status(502).json({ error: 'Nao consegui ler a estimativa' });
    }

    const inteiro = (v, teto) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) return null;
      return Math.min(Math.round(n), teto);
    };

    const validos = new Set(enxuto.map(r => r.id));
    const resultados = (bruto.resultados || [])
      .filter(r => validos.has(String(r.id)))
      .map(r => ({
        id:          String(r.id),
        kcal_porcao: inteiro(r.kcal_porcao, 5000),
        proteina_g:  inteiro(r.proteina_g, 300),
        confianca:   ['alta', 'media', 'baixa'].includes(r.confianca) ? r.confianca : 'media'
      }));

    return res.status(200).json({ resultados });
  } catch (err) {
    console.error('Falha em receita-nutrir:', err);
    return res.status(500).json({ error: err.message || 'Erro ao estimar' });
  }
}
