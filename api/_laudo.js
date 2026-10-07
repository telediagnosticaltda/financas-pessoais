import { requireAuth } from './_auth.js';

// api/_laudo.js
// (Arquivo auxiliar: comeca com "_", por isso NAO conta como funcao da Vercel.
//  O plano gratuito aceita 12 funcoes; as rotas publicas ficam em /api/receita-nutrir:
//    ?tipo=laudo           -> aplica o ditado ao laudo       (tratarLaudo)
//    ?tipo=laudo-checar    -> confere o laudo pronto         (checarLaudo)
//    ?tipo=laudo-anterior  -> resume o laudo do exame anterior (resumirAnterior))
//
// Nada e gravado aqui: o navegador guarda mascaras e correcoes no Supabase.
// O texto do laudo NAO e registrado nos logs.
//
// Variavel de ambiente: ANTHROPIC_API_KEY

const MODELO = 'claude-sonnet-4-6';

const LIM_DITADO    = 4000;
const LIM_CORPO     = 20000;
const LIM_CONCLUSAO = 6000;
const LIM_ANTERIOR  = 12000;
const LIM_EXEMPLOS  = 12;
const LIM_EXEMPLO   = 700;

// ─────────────────────────────────────────────────────────────
// Prompts
// ─────────────────────────────────────────────────────────────

const SISTEMA_DITADO = `Você é um assistente de redação para um médico radiologista brasileiro.
Ele dita, de forma coloquial e resumida, os achados de um exame. Você atualiza o laudo que está aberto (corpo e conclusão), em português do Brasil, com a terminologia radiológica adequada.

REGRAS

1. Altere SOMENTE o que o ditado afeta. Todo o resto do corpo e da conclusão deve voltar exatamente como veio, com as mesmas palavras e as mesmas quebras de linha.

2. Quando o ditado descreve uma alteração em uma estrutura, substitua a frase de normalidade daquela estrutura (ou acrescente uma linha na ordem anatômica da máscara) pela descrição técnica do achado: localização, lateralidade, morfologia, sinal/ecogenicidade/densidade, dimensões e relações, usando apenas o que foi dito ou o que é inerente ao termo. Nunca deixe uma frase normal contradizendo o achado (por exemplo, "sem lesões focais" ao lado de uma lesão).

3. Nunca invente achados, medidas, lateralidade, segmentos, níveis, graus ou datas que não foram ditados. Se faltar algo essencial (lado, segmento, tamanho...), escreva de forma neutra, sem preencher, e acrescente um aviso curto em "avisos".

4. Traduza a fala coloquial para o termo técnico correto mantendo o sentido (por exemplo, "rompimento do menisco" vira "ruptura meniscal"). Siga o padrão de escrita da máscara e dos exemplos de correção.

5. Conclusão: um achado por linha, em frases curtas, do mais importante ao menos importante. NUNCA use numeração (1., 2., 3.), letras, marcadores ou travessões no início das linhas; escreva só o texto de cada achado. Se a conclusão da máscara já tiver outro formato, siga o da máscara. Ao incluir achados, substitua a frase de normalidade da conclusão (por exemplo, "sem alterações significativas"). Achados que já estavam na conclusão e continuam válidos permanecem. Achados incidentais de menor relevância ficam no fim. Não acrescente conduta, diagnóstico diferencial nem recomendação que o médico não ditou, exceto se já constar na máscara.

6. O ditado pode conter comandos de edição ("tira o derrame", "corrige para o lado esquerdo", "essa estrutura está normal"). Aplique-os ao texto atual. Se o ditado disser que uma estrutura está normal, mantenha ou restaure a frase normal dela. Se um achado deixar de existir, retire-o também da conclusão.

7. Se o ditado não tiver conteúdo clínico aproveitável, devolva o texto sem alteração e explique em "avisos".

8. Os "exemplos de correção" mostram como o médico prefere escrever: a versão que a IA tinha escrito e a versão final dele. Use-os só como referência de estilo e de terminologia. Nunca copie os achados deles para este laudo.

9. Texto puro, sem markdown e sem asteriscos. Mantenha o formato de linhas da máscara.

10. Pontuação falada: se restarem no ditado palavras como "ponto", "ponto final", "vírgula", "dois pontos", "ponto e vírgula", "nova linha" ou "parágrafo" usadas como comando de pontuação, interprete como o sinal e nunca as escreva por extenso. "Ponto" como substantivo ("ponto de ossificação", "em um ponto") permanece como palavra.

11. O ditado vem de reconhecimento de voz e pode ter erros de transcrição em termos médicos (por exemplo, "no em Direito" quando o médico disse "no rim direito"). Quando o termo correto for claro pelo contexto anatômico, use-o sem comentar. Se houver dúvida real entre duas leituras, não escolha: escreva de forma neutra e registre a dúvida em "avisos".

12. EXAME ANTERIOR: se vier um laudo anterior (e talvez a data), use-o SOMENTE para redigir as comparações que o médico ditou ("estável", "aumentou", "reduziu", "novo", "sem alterações em relação ao anterior"), citando no texto os valores do anterior que constem nele. Se o médico ditou uma comparação, inclua no corpo uma linha "Comparação: ..." com a data do anterior (se informada), logo após o título/técnica ou onde a máscara já tiver esse campo, e descreva a evolução na linha do próprio achado. Nunca afirme estabilidade, aumento ou resolução de uma estrutura que o médico não mencionou, mesmo que o anterior a descreva. Se a comparação ditada contradisser o anterior (por exemplo, "estável" mas as medidas mudaram), escreva o que o médico ditou e avise em "avisos". Se o anterior não tiver o dado necessário, não invente: avise. Ignore qualquer nome ou dado de identificação que apareça no anterior.

FORMATO DA RESPOSTA
Responda APENAS com um objeto JSON, sem markdown, sem crases e sem texto em volta:

{
  "corpo": "corpo completo do laudo, já atualizado",
  "conclusao": "conclusão completa, já atualizada",
  "avisos": ["pontos que ficaram ambíguos ou que o médico deve conferir; lista vazia se não houver"]
}`;

const SISTEMA_CONFERENCIA = `Você é um revisor de laudos de radiologia (português do Brasil). Recebe o corpo e a conclusão de um laudo já redigido pelo médico e, às vezes, o laudo do exame anterior. Sua tarefa é APONTAR inconsistências. Nunca reescreva o laudo.

Procure somente:
1. Lateralidade: direito/esquerdo (ou lado) divergente entre corpo e conclusão, ou para a mesma estrutura em trechos diferentes.
2. Achado relevante descrito no corpo que não aparece na conclusão (ignore variantes anatômicas e achados incidentais triviais).
3. Achado na conclusão sem suporte no corpo.
4. Contradição: a mesma estrutura descrita como normal e como alterada; frase de normalidade ("sem lesões focais") ao lado de uma lesão; conclusão "sem alterações" com achados no corpo.
5. Números: medidas diferentes para a mesma lesão em trechos distintos; unidades misturadas de modo suspeito (cm e mm); medida implausível por erro de digitação evidente.
6. Com laudo anterior: afirmação de comparação (estável, aumentou, reduziu, novo, resolvido) que contradiz os valores ou achados do anterior.
7. Erro de digitação ou termo claramente trocado (por exemplo, achado hepático descrito no baço).

Regras:
- Aponte só o que for claro. Na dúvida, não aponte.
- Não comente estilo, conduta clínica, diagnóstico diferencial nem o que "faltou examinar".
- Não aponte campos em branco do modelo (como "___" ou "[ ]"): isso é verificado por outro mecanismo.
- Ignore qualquer nome ou dado de identificação.
- gravidade: "alta" para lateralidade, contradição de achado e achado ausente da conclusão; "media" para números e comparação; "baixa" para digitação.

Responda APENAS com um objeto JSON, sem markdown, sem crases e sem texto em volta:

{
  "problemas": [
    { "gravidade": "alta|media|baixa", "titulo": "título curto", "detalhe": "uma frase explicando", "trecho": "trecho curto do laudo envolvido" }
  ]
}

Se não houver nada a apontar, devolva {"problemas": []}.`;

const SISTEMA_ANTERIOR = `Você resume laudos anteriores de radiologia (português do Brasil) para o médico consultar enquanto dita um novo exame. Recebe o texto de um laudo anterior. Não interprete e não acrescente nada. Preserve números, unidades e lateralidade exatamente como estão. Ignore qualquer nome ou dado de identificação.

Responda APENAS com um objeto JSON, sem markdown, sem crases e sem texto em volta:

{
  "data": "data do exame, se constar; senão string vazia",
  "achados": ["cada achado relevante (alterado) em uma frase curta, com localização, lateralidade e medidas"],
  "normais": "uma frase listando as estruturas descritas como normais; string vazia se não houver",
  "conclusao": "conclusão do laudo anterior em no máximo duas frases; string vazia se não houver"
}`;

// ─────────────────────────────────────────────────────────────
// Utilitarios
// ─────────────────────────────────────────────────────────────

class ErroHttp extends Error {
  constructor(status, mensagem) { super(mensagem); this.status = status; }
}

const texto = (v, limite) => String(v ?? '').slice(0, limite);

function extrairJson(bruto) {
  const limpo = bruto.replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(limpo);
  } catch {
    const ini = limpo.indexOf('{');
    const fim = limpo.lastIndexOf('}');
    if (ini === -1 || fim <= ini) return null;
    try { return JSON.parse(limpo.slice(ini, fim + 1)); } catch { return null; }
  }
}

async function perguntar(sistema, mensagem, maxTokens) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new ErroHttp(500, 'ANTHROPIC_API_KEY nao configurada');

  const resposta = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODELO,
      max_tokens: maxTokens,
      temperature: 0.2,
      system: sistema,
      messages: [{ role: 'user', content: mensagem }]
    })
  });

  if (!resposta.ok) {
    // So o status e o inicio do erro da API; nunca o texto do laudo.
    console.error('[laudo] claude', resposta.status, (await resposta.text()).slice(0, 200));
    throw new ErroHttp(502, 'A Claude API recusou a requisicao');
  }

  const data = await resposta.json();
  if (data.stop_reason === 'max_tokens') {
    throw new ErroHttp(502, 'A resposta veio cortada. Tente de novo com um texto menor.');
  }

  const bruto = (data.content || [])
    .filter(c => c.type === 'text').map(c => c.text).join('\n');
  const saida = extrairJson(bruto);
  if (!saida) {
    console.error('[laudo] resposta fora do formato esperado');
    throw new ErroHttp(502, 'Nao consegui ler a resposta da IA. Tente de novo.');
  }
  return saida;
}

// Autenticacao, metodo, tratamento de erro: iguais para os tres servicos
async function executar(req, res, servico) {
  if (!(await requireAuth(req, res))) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
  try {
    const saida = await servico(req.body || {});
    return res.status(200).json(saida);
  } catch (err) {
    if (err instanceof ErroHttp) return res.status(err.status).json({ error: err.message });
    console.error('Falha em laudo:', err?.message || err);
    return res.status(500).json({ error: 'Erro ao processar o laudo' });
  }
}

const blocoAnterior = (anterior, data) => anterior
  ? `\n\nEXAME ANTERIOR${data ? ` (data: ${data})` : ''}:\n<<<\n${anterior}\n>>>`
  : '';

// ─────────────────────────────────────────────────────────────
// 1) Aplicar o ditado
// ─────────────────────────────────────────────────────────────

export function tratarLaudo(req, res) {
  return executar(req, res, async (b) => {
    const ditado = texto(b.ditado, LIM_DITADO + 1).trim();
    if (!ditado) throw new ErroHttp(400, 'Nada foi ditado');
    if (ditado.length > LIM_DITADO) {
      throw new ErroHttp(400, `Ditado muito longo (maximo ${LIM_DITADO} caracteres)`);
    }

    const corpoOriginal     = String(b.corpo ?? '');
    const conclusaoOriginal = String(b.conclusao ?? '');
    if (corpoOriginal.length > LIM_CORPO || conclusaoOriginal.length > LIM_CONCLUSAO) {
      throw new ErroHttp(400, 'Laudo grande demais para processar');
    }
    if (!corpoOriginal.trim() && !conclusaoOriginal.trim()) {
      throw new ErroHttp(400, 'Abra uma mascara antes de ditar');
    }

    const tipo = texto(b.tipo_exame, 120).trim() || 'nao informado';
    const anterior = texto(b.anterior, LIM_ANTERIOR).trim();
    const dataAnterior = texto(b.data_anterior, 40).trim();

    const exemplos = (Array.isArray(b.exemplos) ? b.exemplos : [])
      .slice(0, LIM_EXEMPLOS)
      .map(e => ({ antes: texto(e?.antes, LIM_EXEMPLO), depois: texto(e?.depois, LIM_EXEMPLO) }))
      .filter(e => e.antes.trim() || e.depois.trim());

    const blocoExemplos = exemplos.length
      ? exemplos.map((e, i) =>
          `${i + 1}) IA escreveu: ${e.antes.trim() || '(nada)'}\n   Médico deixou: ${e.depois.trim() || '(removeu)'}`
        ).join('\n')
      : '(ainda não há correções registradas para este tipo de exame)';

    const mensagem =
`TIPO DE EXAME: ${tipo}

CORPO ATUAL DO LAUDO:
<<<
${corpoOriginal}
>>>

CONCLUSÃO ATUAL:
<<<
${conclusaoOriginal}
>>>

EXEMPLOS DE CORREÇÃO DO MÉDICO (referência de estilo):
${blocoExemplos}${blocoAnterior(anterior, dataAnterior)}

DITADO DO MÉDICO (aplique ao laudo):
<<<
${ditado}
>>>`;

    const saida = await perguntar(SISTEMA_DITADO, mensagem, 4000);
    if (typeof saida.corpo !== 'string' || typeof saida.conclusao !== 'string') {
      console.error('[laudo] resposta sem corpo/conclusao');
      throw new ErroHttp(502, 'Nao consegui ler a resposta da IA. Tente de novo.');
    }

    const avisos = (Array.isArray(saida.avisos) ? saida.avisos : [])
      .map(a => String(a).trim()).filter(Boolean).slice(0, 8);

    return {
      corpo: saida.corpo.replace(/\r\n/g, '\n'),
      conclusao: saida.conclusao.replace(/\r\n/g, '\n'),
      avisos
    };
  });
}

// ─────────────────────────────────────────────────────────────
// 2) Conferir o laudo pronto
// ─────────────────────────────────────────────────────────────

const ORDEM_GRAVIDADE = { alta: 0, media: 1, baixa: 2 };

export function checarLaudo(req, res) {
  return executar(req, res, async (b) => {
    const corpo = String(b.corpo ?? '');
    const conclusao = String(b.conclusao ?? '');
    if (corpo.length > LIM_CORPO || conclusao.length > LIM_CONCLUSAO) {
      throw new ErroHttp(400, 'Laudo grande demais para conferir');
    }
    if (!corpo.trim() && !conclusao.trim()) throw new ErroHttp(400, 'Nao ha laudo para conferir');

    const tipo = texto(b.tipo_exame, 120).trim() || 'nao informado';
    const anterior = texto(b.anterior, LIM_ANTERIOR).trim();
    const dataAnterior = texto(b.data_anterior, 40).trim();

    const mensagem =
`TIPO DE EXAME: ${tipo}

CORPO DO LAUDO:
<<<
${corpo}
>>>

CONCLUSÃO:
<<<
${conclusao}
>>>${blocoAnterior(anterior, dataAnterior)}`;

    const saida = await perguntar(SISTEMA_CONFERENCIA, mensagem, 1500);

    const problemas = (Array.isArray(saida.problemas) ? saida.problemas : [])
      .map(p => ({
        gravidade: ORDEM_GRAVIDADE[p?.gravidade] !== undefined ? p.gravidade : 'media',
        titulo:  texto(p?.titulo, 120).trim(),
        detalhe: texto(p?.detalhe, 300).trim(),
        trecho:  texto(p?.trecho, 200).trim()
      }))
      .filter(p => p.titulo || p.detalhe)
      .sort((a, c) => ORDEM_GRAVIDADE[a.gravidade] - ORDEM_GRAVIDADE[c.gravidade])
      .slice(0, 8);

    return { problemas };
  });
}

// ─────────────────────────────────────────────────────────────
// 3) Resumir o laudo do exame anterior
// ─────────────────────────────────────────────────────────────

export function resumirAnterior(req, res) {
  return executar(req, res, async (b) => {
    const anterior = texto(b.anterior, LIM_ANTERIOR + 1).trim();
    if (!anterior) throw new ErroHttp(400, 'Cole o laudo anterior');
    if (anterior.length > LIM_ANTERIOR) throw new ErroHttp(400, 'Laudo anterior grande demais');

    const mensagem = `LAUDO ANTERIOR:\n<<<\n${anterior}\n>>>`;
    const saida = await perguntar(SISTEMA_ANTERIOR, mensagem, 1500);

    return {
      data: texto(saida.data, 40).trim(),
      achados: (Array.isArray(saida.achados) ? saida.achados : [])
        .map(a => texto(a, 300).trim()).filter(Boolean).slice(0, 20),
      normais: texto(saida.normais, 500).trim(),
      conclusao: texto(saida.conclusao, 500).trim()
    };
  });
}
