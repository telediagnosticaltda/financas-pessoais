// api/parse-pdf.js
export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST')    { res.status(405).json({ error: 'Método não permitido' }); return; }

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada' });
  }

  const { text } = req.body;
  if (!text || text.trim().length < 50) {
    return res.status(400).json({ error: 'Texto do PDF não recebido ou muito curto' });
  }

  const prompt = `Você é um especialista em extrair dados de faturas de cartão de crédito brasileiras.

Analise o texto abaixo extraído de uma fatura do cartão EQI/BTG Pactual e extraia TODAS as transações de compra.

O formato típico desta fatura é:
DD Mês  Descrição (parcela)  R$ valor

Onde:
- DD = dia (ex: 25, 08, 30)
- Mês = abreviação em português (Jan, Fev, Mar, Abr, Mai, Jun, Jul, Ago, Set, Out, Nov, Dez)
- Descrição = nome do estabelecimento, às vezes seguido de (X/Y) indicando parcela X de Y
- R$ valor = o valor da compra

A página de lançamentos pode ter duas colunas lado a lado — extraia transações de AMBAS as colunas.

O texto também pode ter um ⊕ ou símbolos extras após os valores — ignore-os.

Retorne APENAS um array JSON válido, sem markdown, sem texto extra:
[{"date":"YYYY-MM-DD","description":"Nome do estabelecimento","amount":99.90,"type":"expense"}]

Regras:
- "amount": número positivo (ex: 89.50, não "R$ 89,50")
- "date": formato YYYY-MM-DD
  - Para determinar o ano: a fatura é de Junho de 2026 (período 27/04 a 28/05/2026)
  - Transações de Mai/Abr/Mar/Fev/Jan de 2026 → ano 2026
  - Transações de Dez/Nov/Out/Set/Ago/Jul de anos anteriores → ano 2025
  - Transações com data muito antiga (ex: Ago, Out, Nov, Dez) são parcelas de compras antigas → use 2025
- "type": "expense" para compras, "income" para estornos/créditos
- NÃO inclua: pagamentos de fatura, total da fatura, encargos, IOF, limites, mensalidade do cartão
- Inclua parcelamentos (cada parcela = uma linha separada)
- Se uma linha só tiver "Pagamento de fatura" ou "Pagamento" → NÃO inclua

TEXTO DA FATURA:
${text}

Retorne SOMENTE o JSON array.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 8000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(500).json({ error: data.error?.message || 'Erro na API da Anthropic' });
    }

    const rawText = data.content.map(b => b.text || '').join('').trim();
    let transactions;
    try {
      transactions = JSON.parse(rawText);
    } catch {
      const match = rawText.match(/\[[\s\S]*\]/);
      if (match) {
        try { transactions = JSON.parse(match[0]); }
        catch { return res.status(500).json({ error: 'Resposta inválida da IA', raw: rawText.slice(0, 300) }); }
      } else {
        return res.status(500).json({ error: 'IA não retornou JSON', raw: rawText.slice(0, 300) });
      }
    }

    return res.status(200).json({ transactions });

  } catch (err) {
    console.error('[parse-pdf] erro:', err);
    return res.status(500).json({ error: err.message });
  }
}
