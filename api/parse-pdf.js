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

  const today = new Date().toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });

  const prompt = `Você é um especialista em extrair dados de documentos financeiros brasileiros.

Analise o texto abaixo — pode ser uma FATURA DE CARTÃO DE CRÉDITO ou um EXTRATO DE CONTA CORRENTE.

PARA FATURA DE CARTÃO (EQI, BTG, XP, Nubank Crédito):
- Extraia cada compra/parcela como "expense"
- Estornos e créditos como "income"
- Inclua parcelamentos (cada parcela = uma linha separada)
- NÃO inclua: total da fatura, pagamento de fatura, encargos, IOF, limite disponível

PARA NOTIFICAÇÃO DE TRANSAÇÃO AVULSA (e-mail do Nubank sobre Pix, transferência, etc.):
- Extraia APENAS a transação descrita neste e-mail (1 transação por e-mail)
- "Transferência enviada", "Pix enviado", "Pagamento realizado" = "expense"
- "Transferência recebida", "Pix recebido", "Dinheiro recebido" = "income"
- Use o nome do destinatário/remetente como descrição
- A data é a data do e-mail ou a informada no corpo
- Se não houver transação financeira (e-mail de marketing, notificação sem valor), retorne []

PARA EXTRATO DE CONTA CORRENTE (Nubank conta, etc):
- "Transferência recebida", "Pix recebido", "Depósito", "Salário" = "income" → sempre inclua
- "Transferência enviada", "Pix enviado" para pessoas/empresas = "expense" → inclua
- "Pagamento de boleto" para contas comuns (escola, condomínio, energia, serviços) = "expense" → inclua
- NÃO inclua: saldo inicial, saldo final, rendimento da conta
- Para descrição: use o nome do destinatário/remetente (não inclua agência, conta, CNPJ)

REGRA CRÍTICA - EVITAR DUPLA CONTAGEM:
NÃO inclua pagamentos de fatura de cartão de crédito:
- "Pagamento de boleto" ou "Pagamento de fatura" para: BTG Pactual, Banco XP, XP Investimentos,
  Nubank (crédito), Itaú, Bradesco, Santander, C6, Inter, Caixa e similares
- Esses gastos já foram capturados pelas faturas individuais dos cartões
- Em caso de dúvida, EXCLUA

Referência de data: ${today}

Retorne APENAS um array JSON válido, sem texto antes ou depois, sem markdown:
[{"date":"YYYY-MM-DD","description":"Nome limpo do estabelecimento ou pessoa","amount":99.90,"type":"expense"}]

Regras:
- amount: sempre número positivo
- date: YYYY-MM-DD com o ano correto (para extratos de conta, use a data da movimentação)
- type: "expense" para saídas/pagamentos/transferências enviadas, "income" para entradas/recebimentos
- Retorne SOMENTE o JSON, nada mais

TEXTO DO DOCUMENTO:
${text}`;

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

    // Filtrar transações com datas futuras (parcelamentos ainda não vencidos)
    const today = new Date().toISOString().slice(0, 10);
    const filtered = transactions.filter(t => t.date <= today);

    return res.status(200).json({ transactions: filtered });

  } catch (err) {
    console.error('[parse-pdf] erro:', err);
    return res.status(500).json({ error: err.message });
  }
}
