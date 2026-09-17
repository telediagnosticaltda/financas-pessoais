import { requireAuth } from './_auth.js';

// api/extract-receipt.js
// Recebe um recibo médico (PDF ou imagem em base64) e devolve os campos
// necessários para a ficha "Pagamentos Efetuados" da declaracao de IR.
//
// Variavel de ambiente necessaria: ANTHROPIC_API_KEY

const MODEL = 'claude-sonnet-4-6';

const PROMPT = `Voce esta lendo um recibo, nota fiscal ou comprovante de despesa medica brasileira.

Extraia os dados e responda APENAS com um objeto JSON, sem markdown, sem crases, sem nenhum texto antes ou depois.

Formato exato:
{
  "provider_name": "nome do prestador (clinica, hospital, laboratorio ou profissional)",
  "provider_doc": "CPF ou CNPJ do prestador, apenas digitos, ou null",
  "provider_doc_type": "cpf" | "cnpj" | null,
  "date": "AAAA-MM-DD",
  "amount": 000.00,
  "patient_name": "nome do paciente atendido, ou null",
  "expense_type": "consulta" | "exame" | "dentista" | "psicologo" | "fisioterapia" | "hospital" | "outros",
  "confidence": "alta" | "media" | "baixa",
  "warnings": ["avisos curtos sobre campos duvidosos"]
}

Regras:
- date: se o documento trouxer data no formato DD/MM/AAAA, converta para AAAA-MM-DD.
- amount: numero puro, ponto como separador decimal, sem "R$" e sem separador de milhar.
  "R$ 1.250,00" vira 1250.00
- Se houver mais de um valor, use o valor efetivamente pago pelo paciente.
  Ignore valores de coparticipacao de plano, descontos e subtotais.
- provider_doc: remova pontos, barras e tracos. 11 digitos e cpf, 14 digitos e cnpj.
- patient_name: o nome de quem foi ATENDIDO. Se o recibo so trouxer o nome de quem
  pagou e nao der para distinguir, use esse nome mesmo e registre em warnings.
- Se um campo nao existir no documento, use null. Nunca invente dados.
- confidence "baixa" se a imagem estiver ilegivel ou faltarem campos essenciais.`;

export default async function handler(req, res) {
  if (!(await requireAuth(req, res))) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY nao configurada' });
  }

  try {
    const { fileData, mediaType } = req.body || {};

    if (!fileData || !mediaType) {
      return res.status(400).json({ error: 'Envie fileData (base64) e mediaType' });
    }

    const isPdf = mediaType === 'application/pdf';
    const allowedImages = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

    if (!isPdf && !allowedImages.includes(mediaType)) {
      return res.status(400).json({
        error: `Tipo nao suportado: ${mediaType}. Use PDF, JPEG, PNG, WEBP ou GIF.`
      });
    }

    const fileBlock = isPdf
      ? {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: fileData }
        }
      : {
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: fileData }
        };

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1000,
        messages: [
          { role: 'user', content: [fileBlock, { type: 'text', text: PROMPT }] }
        ]
      })
    });

    if (!response.ok) {
      const detalhe = await response.text();
      console.error('Erro da Claude API:', response.status, detalhe);
      return res.status(502).json({
        error: 'A Claude API recusou a requisicao',
        status: response.status
      });
    }

    const data = await response.json();

    const texto = (data.content || [])
      .filter((bloco) => bloco.type === 'text')
      .map((bloco) => bloco.text)
      .join('\n')
      .trim();

    const limpo = texto.replace(/```json/gi, '').replace(/```/g, '').trim();

    let extraido;
    try {
      extraido = JSON.parse(limpo);
    } catch (err) {
      console.error('Resposta nao era JSON valido:', limpo);
      return res.status(502).json({
        error: 'Nao consegui ler o recibo. Tente uma foto mais nitida.',
        raw: limpo.slice(0, 500)
      });
    }

    return res.status(200).json({
      provider_name: extraido.provider_name ?? null,
      provider_doc: extraido.provider_doc
        ? String(extraido.provider_doc).replace(/\D/g, '')
        : null,
      provider_doc_type: extraido.provider_doc_type ?? null,
      date: extraido.date ?? null,
      amount:
        extraido.amount === null || extraido.amount === undefined
          ? null
          : Number(extraido.amount),
      patient_name: extraido.patient_name ?? null,
      expense_type: extraido.expense_type ?? 'outros',
      confidence: extraido.confidence ?? 'media',
      warnings: Array.isArray(extraido.warnings) ? extraido.warnings : []
    });
  } catch (err) {
    console.error('Falha em extract-receipt:', err);
    return res.status(500).json({ error: 'Erro interno ao processar o recibo' });
  }
}
