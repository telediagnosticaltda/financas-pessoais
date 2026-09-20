// sw.js — service worker do app Finanças
//
// Faz duas coisas, e só:
//   1. recebe o que você compartilha do celular (vídeo, imagem ou link) e
//      guarda até o app abrir;
//   2. mostra uma tela simples quando o celular está sem internet.
//
// Ele NÃO guarda cópia do aplicativo. Isso é de propósito: assim toda vez que
// você abre, vem a versão mais nova publicada na Vercel, sem ficar preso numa
// versão antiga em cache.

const CACHE_OFFLINE      = 'financas-offline-v1';
const CACHE_COMPARTILHADO = 'financas-compartilhado';

self.addEventListener('install', (evento) => {
  evento.waitUntil(
    caches.open(CACHE_OFFLINE)
      .then((c) => c.add('/offline.html'))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil((async () => {
    const nomes = await caches.keys();
    await Promise.all(
      nomes.filter((n) => n.startsWith('financas-offline-') && n !== CACHE_OFFLINE)
           .map((n) => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (evento) => {
  const req = evento.request;
  const url = new URL(req.url);

  // ── Compartilhamento vindo do celular ──
  if (req.method === 'POST' && url.pathname === '/share-target') {
    evento.respondWith((async () => {
      try {
        const form = await req.formData();
        const cache = await caches.open(CACHE_COMPARTILHADO);

        const arquivo = (form.getAll('video')[0] || form.getAll('imagem')[0]) || null;
        const texto = [form.get('url'), form.get('text'), form.get('title')]
          .filter(Boolean).join('\n');

        if (arquivo && arquivo.size > 0) {
          await cache.put('/__compartilhado/arquivo', new Response(arquivo, {
            headers: {
              'content-type': arquivo.type || 'application/octet-stream',
              'x-nome-arquivo': encodeURIComponent(arquivo.name || 'compartilhado')
            }
          }));
        }
        if (texto) {
          await cache.put('/__compartilhado/texto', new Response(texto));
        }
      } catch (err) {
        console.error('[sw] falha ao receber o compartilhamento', err);
      }
      return Response.redirect('/?compartilhado=1', 303);
    })());
    return;
  }

  // ── Navegação: rede primeiro, tela offline como último recurso ──
  if (req.mode === 'navigate') {
    evento.respondWith(
      fetch(req).catch(async () => {
        const c = await caches.open(CACHE_OFFLINE);
        return (await c.match('/offline.html')) ||
               new Response('Sem conexão', { status: 503 });
      })
    );
  }
  // Todo o resto segue direto para a rede, sem interferência.
});
