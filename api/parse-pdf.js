// api/parse-pdf.js
export const config = { api: { bodyParser: { sizeLimit: '15mb' } } };

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
      text: `Você é um especialista em extrair dados de faturas de cartão de crédito brasileiras.

Analise TODAS as imagens desta fatura e extraia TODAS as transações — compras, parcelamentos, assinaturas, débitos.

As faturas brasileiras costumam ter tabelas com colunas como: DATA | ESTABELECIMENTO/DESCRIÇÃO | VALOR
Parcelamentos aparecem como "2/12" ou "Parcela 2 de 12" — inclua cada parcela como uma linha separada.

Retorne APENAS um array JSON, sem markdown, sem texto extra:
[{"date":"YYYY-MM-DD","description":"Nome do estabelecimento","amount":99.90,"type":"expense"}]

Regras obrigatórias:
- "amount": número positivo sem símbolo de moeda (ex: 89.50)
- "date": formato YYYY-MM-DD. Se só aparecer dia/mês, use o ano da fatura
- "type": "expense" para compras/débitos, "income" para estornos/créditos/reembolsos
- NÃO inclua: total da fatura, valor do pagamento, encargos financeiros, IOF, limite de crédito, saldo
- Se não encontrar nenhuma transação nas imagens, retorne um array vazio: []
- Retorne SOMENTE o JSON`
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
      if (match) {
        try { transactions = JSON.parse(match[0]); }
        catch { return res.status(500).json({ error: 'Resposta inválida da IA', raw: text.slice(0, 500) }); }
      } else {
        return res.status(500).json({ error: 'IA não retornou JSON válido', raw: text.slice(0, 500) });
      }
    }

    return res.status(200).json({ transactions, pages: images.length });

  } catch (err) {
    console.error('[parse-pdf] erro:', err);
    return res.status(500).json({ error: err.message });
  }
}
