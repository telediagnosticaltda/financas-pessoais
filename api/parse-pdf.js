// api/parse-pdf.js
// Recebe imagens das páginas do PDF e usa a API da Anthropic para extrair transações

export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST')    { res.status(405).json({ error: 'Método não permitido' }); return; }

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada nas variáveis de ambiente da Vercel' });
  }

  const { images } = req.body;
  if (!images?.length) {
    return res.status(400).json({ error: 'Nenhuma imagem recebida' });
  }

  const content = [
    ...images.map(img => ({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: img }
    })),
    {
      type: 'text',
      text: `Você é um extrator de dados financeiros. Analise as imagens desta fatura de cartão de crédito brasileiro e extraia todas as transações de compra.

Retorne APENAS um array JSON válido, sem texto antes ou depois, sem blocos de código markdown:
[{"date":"YYYY-MM-DD","description":"nome do estabelecimento","amount":99.90,"type":"expense"}]

Regras:
- "amount" sempre número positivo (ex: 89.50)
- "date" sempre YYYY-MM-DD — se o ano não aparecer, use o ano da fatura
- "type": "expense" para compras, "income" para estornos/créditos
- Inclua TODAS as compras e cada parcela individualmente
- NÃO inclua: total da fatura, pagamento, encargos, IOF, limites
- Retorne SOMENTE o JSON, nada mais`
    }
  ];

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
        max_tokens: 4000,
        messages: [{ role: 'user', content }]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(500).json({ error: data.error?.message || 'Erro na API da Anthropic' });
    }

    const text = data.content.map(b => b.text || '').join('').trim();
    let transactions;
    try {
      transactions = JSON.parse(text);
    } catch {
      const match = text.match(/\[[\s\S]*\]/);
      if (match) transactions = JSON.parse(match[0]);
      else return res.status(500).json({ error: 'IA não conseguiu extrair as transações' });
    }

    return res.status(200).json({ transactions });

  } catch (err) {
    console.error('[parse-pdf] erro:', err);
    return res.status(500).json({ error: err.message });
  }
}
