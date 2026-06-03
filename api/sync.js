export default async function handler(req, res) {
  // CORS — permite que o app HTML chame essa função
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST')    { res.status(405).json({ error: 'Método não permitido' }); return; }

  const CLIENT_ID     = process.env.PLUGGY_CLIENT_ID;
  const CLIENT_SECRET = process.env.PLUGGY_CLIENT_SECRET;
  const SB_URL        = process.env.SUPABASE_URL;
  const SB_KEY        = process.env.SUPABASE_KEY;

  if (!CLIENT_ID || !CLIENT_SECRET || !SB_URL || !SB_KEY) {
    return res.status(500).json({ success: false, error: 'Variáveis de ambiente não configuradas' });
  }

  const sbH = {
    'apikey': SB_KEY,
    'Authorization': `Bearer ${SB_KEY}`,
    'Content-Type': 'application/json'
  };

  try {
    // ── 1. Autenticar na Pluggy ──────────────────────────────────
    const authRes  = await fetch('https://api.pluggy.ai/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })
    });
    const authData = await authRes.json();
    const apiKey   = authData.apiKey;
    if (!apiKey) throw new Error('Falha na autenticação com a Pluggy: ' + JSON.stringify(authData));

    const pgH = { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' };

    // ── 2. Buscar itens conectados na Pluggy ─────────────────────
    const itemsRes  = await fetch('https://api.pluggy.ai/items', { headers: pgH });
    const itemsData = await itemsRes.json();
    const items     = itemsData.results || [];
    if (!items.length) throw new Error('Nenhuma conta conectada encontrada na Pluggy. Verifique meu.pluggy.ai.');

    // ── 3. Buscar contas no Supabase ─────────────────────────────
    const sbAccRes  = await fetch(`${SB_URL}/rest/v1/accounts?select=*&active=eq.true`, { headers: sbH });
    const sbAccounts = await sbAccRes.json();

    let totalImported = 0, totalDuplicates = 0, totalErrors = 0;
    const log = [];

    // ── 4. Para cada item/banco da Pluggy ────────────────────────
    for (const item of items) {
      const connectorName = item.connector?.name || 'Desconhecido';

      // Buscar contas deste item
      const accsRes  = await fetch(`https://api.pluggy.ai/accounts?itemId=${item.id}`, { headers: pgH });
      const accsData = await accsRes.json();
      const pluggyAccounts = accsData.results || [];

      for (const pluggyAcc of pluggyAccounts) {

        // Tentar casar com conta do Supabase pelo pluggy_account_id salvo ou pelo nome da instituição
        let sbAcc = sbAccounts.find(a => a.pluggy_account_id === pluggyAcc.id);

        if (!sbAcc) {
          // Correspondência por nome da instituição (ex: "BTG" bate com "BTG Pactual")
          const connLower = connectorName.toLowerCase();
          sbAcc = sbAccounts.find(a => {
            const instWords = (a.institution || '').toLowerCase().split(' ');
            return instWords.some(w => w.length > 2 && connLower.includes(w));
          });

          // Salvar o pluggy_account_id para buscas futuras (mais rápido)
          if (sbAcc) {
            await fetch(`${SB_URL}/rest/v1/accounts?id=eq.${sbAcc.id}`, {
              method: 'PATCH',
              headers: { ...sbH, 'Prefer': 'return=minimal' },
              body: JSON.stringify({ pluggy_account_id: pluggyAcc.id })
            });
          }
        }

        if (!sbAcc) {
          log.push({ status: 'warn', msg: `"${connectorName}" não foi associado a nenhuma conta cadastrada` });
          continue;
        }

        // Buscar transações dos últimos 90 dias
        const dateFrom = new Date();
        dateFrom.setDate(dateFrom.getDate() - 90);
        const dateFromStr = dateFrom.toISOString().slice(0, 10);

        let page = 1, hasMore = true, accImported = 0, accDupl = 0;

        while (hasMore) {
          const txRes  = await fetch(
            `https://api.pluggy.ai/transactions?accountId=${pluggyAcc.id}&from=${dateFromStr}&pageSize=500&page=${page}`,
            { headers: pgH }
          );
          const txData = await txRes.json();
          const txs    = txData.results || [];
          if (!txs.length) break;

          for (const tx of txs) {
            const extId = String(tx.id);

            // Verificar duplicata
            const checkRes = await fetch(
              `${SB_URL}/rest/v1/transactions?external_id=eq.${encodeURIComponent(extId)}&select=id`,
              { headers: sbH }
            );
            const existing = await checkRes.json();
            if (existing.length > 0) { accDupl++; continue; }

            // Determinar tipo e valor
            const amount = Math.abs(tx.amount);
            const type   = tx.amount < 0 ? 'expense' : 'income';
            const desc   = tx.description || tx.paymentData?.paymentMethod || 'Transação importada';

            // Inserir no Supabase
            const insRes = await fetch(`${SB_URL}/rest/v1/transactions`, {
              method: 'POST',
              headers: { ...sbH, 'Prefer': 'return=minimal' },
              body: JSON.stringify({
                date: tx.date.slice(0, 10),
                description: desc,
                amount,
                type,
                account_id: sbAcc.id,
                source: 'pluggy',
                external_id: extId
              })
            });

            if (insRes.ok || insRes.status === 201) accImported++;
            else totalErrors++;
          }

          hasMore = (txData.totalPages || 1) > page;
          page++;
        }

        totalImported  += accImported;
        totalDuplicates += accDupl;
        log.push({ status: 'ok', msg: `${connectorName} (${sbAcc.name}): ${accImported} importadas, ${accDupl} já existiam` });
      }
    }

    return res.status(200).json({
      success: true,
      imported: totalImported,
      duplicates: totalDuplicates,
      errors: totalErrors,
      log
    });

  } catch (err) {
    console.error('[sync] erro:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
