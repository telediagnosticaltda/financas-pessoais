// Webhook da Pluggy — recebe notificações automáticas de novas transações
// Por enquanto apenas confirma o recebimento (status 200)
// Futuramente pode disparar sincronização automática

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // Log do evento recebido (visível nos logs da Vercel)
  const event = req.body?.event || 'unknown';
  console.log('[pluggy-webhook] evento recebido:', event, new Date().toISOString());

  // Confirmar recebimento para a Pluggy
  res.status(200).json({ received: true, event });
}
