import { requireAuth } from './_auth.js';

// api/_laudo.js
// (Arquivo auxiliar: comeca com "_", por isso NAO conta como funcao da Vercel.
//  O plano gratuito aceita 12 funcoes; a rota publica e /api/receita-nutrir?tipo=laudo,
//  que chama tratarLaudo() daqui.)
// Recebe o laudo aberto no editor (corpo + conclusao) e o que o medico ditou de
// forma coloquial, e devolve o laudo atualizado com a terminologia radiologica.
//
// Nada e gravado aqui: o navegador guarda mascaras e correcoes no Supabase.
// O texto do laudo NAO e registrado nos logs.
//
// Variavel de ambiente: ANTHROPIC_API_KEY

const MODELO = 'claude-sonnet-4-6';

const LIM_DITADO    = 4000;
const LIM_CORPO     = 20000;
const LIM_CONCLUSAO = 6000;
const LIM_EXEMPLOS  = 12;
const LIM_EXEMPLO   = 700;

const SISTEMA = `Você é um assistente de redação para um médico radiologista brasileiro.
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

FORMATO DA RESPOSTA
Responda APENAS com um objeto JSON, sem markdown, sem crases e sem texto em volta:

{
  "corpo": "corpo completo do laudo, já atualizado",
  "conclusao": "conclusão completa, já atualizada",
  "avisos": ["pontos que ficaram ambíguos ou que o médico deve conferir; lista vazia se não houver"]
}`;

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

export async function tratarLaudo(req, res) {
  if (!(await requireAuth(req, res))) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY nao configurada' });

  try {
    const b = req.body || {};
    const ditado = texto(b.ditado, LIM_DITADO + 1).trim();
    if (!ditado) return res.status(400).json({ error: 'Nada foi ditado' });
    if (ditado.length > LIM_DITADO) {
      return res.status(400).json({ error: `Ditado muito longo (maximo ${LIM_DITADO} caracteres)` });
    }

    const corpoOriginal     = String(b.corpo ?? '');
    const conclusaoOriginal = String(b.conclusao ?? '');
    if (corpoOriginal.length > LIM_CORPO || conclusaoOriginal.length > LIM_CONCLUSAO) {
      return res.status(400).json({ error: 'Laudo grande demais para processar' });
    }
    if (!corpoOriginal.trim() && !conclusaoOriginal.trim()) {
      return res.status(400).json({ error: 'Abra uma mascara antes de ditar' });
    }

    const tipo = texto(b.tipo_exame, 120).trim() || 'nao informado';

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
${blocoExemplos}

DITADO DO MÉDICO (aplique ao laudo):
<<<
${ditado}
>>>`;

    const resposta = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODELO,
        max_tokens: 4000,
        temperature: 0.2,
        system: SISTEMA,
        messages: [{ role: 'user', content: mensagem }]
      })
    });

    if (!resposta.ok) {
      // So o status e o inicio do erro da API; nunca o texto do laudo.
      console.error('[laudo] claude', resposta.status, (await resposta.text()).slice(0, 200));
      return res.status(502).json({ error: 'A Claude API recusou a requisicao' });
    }

    const data = await resposta.json();
    if (data.stop_reason === 'max_tokens') {
      return res.status(502).json({ error: 'A resposta veio cortada. Tente ditar em partes menores.' });
    }

    const bruto = (data.content || [])
      .filter(c => c.type === 'text').map(c => c.text).join('\n');

    const saida = extrairJson(bruto);
    if (!saida || typeof saida.corpo !== 'string' || typeof saida.conclusao !== 'string') {
      console.error('[laudo] resposta fora do formato esperado');
      return res.status(502).json({ error: 'Nao consegui ler a resposta da IA. Tente de novo.' });
    }

    const avisos = (Array.isArray(saida.avisos) ? saida.avisos : [])
      .map(a => String(a).trim()).filter(Boolean).slice(0, 8);

    return res.status(200).json({
      corpo: saida.corpo.replace(/\r\n/g, '\n'),
      conclusao: saida.conclusao.replace(/\r\n/g, '\n'),
      avisos
    });
  } catch (err) {
    console.error('Falha em laudo:', err?.message || err);
    return res.status(500).json({ error: 'Erro ao aplicar o ditado' });
  }
}
