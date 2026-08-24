// PetStore Scadenze loader v2.47
(async function() {
  const n = 14;
  const parts = [];
  for (let i = 0; i < n; i++) {
    const r = await fetch('./app-chunk-' + i + '.js?v=2.47');
    if (!r.ok) throw new Error('chunk ' + i + ' HTTP ' + r.status);
    parts.push(await r.text());
  }
  const code = parts.join('');
  const s = document.createElement('script');
  s.textContent = code;
  document.head.appendChild(s);
})().catch(e => {
  document.body.innerHTML = '<p style="padding:2rem;font-family:sans-serif">Errore caricamento app: ' + e + '. Prova a svuotare la cache.</p>';
});
