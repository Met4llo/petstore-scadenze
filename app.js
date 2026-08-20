// Compatibility shim – full app is in app-core.js + app-features.js (v1.58)
console.warn('app.js is deprecated; loading split modules...');
(function(){
  function load(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  // Only load if not already present
  if (!window.__petstoreCoreLoaded) {
    load('app-core.js?v=1.58').then(() => load('app-features.js?v=1.58')).catch(console.error);
  }
})();
