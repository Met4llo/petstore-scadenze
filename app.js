// Temporary loader: last good build (v2.46) from jsDelivr while restoring v2.47
(function(){
  var s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/gh/Met4llo/petstore-scadenze@4d68c7b6d3e9ef0a0be72b7c24d5a9955e6a8df3/app.js';
  s.onerror = function(){
    document.body.innerHTML = '<p style="padding:2rem;font-family:sans-serif">Errore caricamento. Contatta assistenza.</p>';
  };
  document.head.appendChild(s);
})();
