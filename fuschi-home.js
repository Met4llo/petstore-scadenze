/* fuschi-home.js — solo Fuschi: tasto Prodotti da segnalare in Home */
(function () {
  function operatorName() {
    return localStorage.getItem('petstore_operator') || '';
  }

  function applyFuschiVisibility() {
    var op = operatorName();
    document.querySelectorAll('.menu-fuschi-only').forEach(function (btn) {
      if (op === 'Fuschi') btn.classList.remove('hidden');
      else btn.classList.add('hidden');
    });
  }

  function openUnsignaledList() {
    if (typeof window.setListFilter === 'function') {
      window.setListFilter('unsignaled');
    } else {
      var lf = document.getElementById('list-filter');
      if (lf) {
        lf.value = 'unsignaled';
        lf.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    if (typeof window.showPage === 'function') {
      window.showPage('list');
      return;
    }
    document.querySelectorAll('.page').forEach(function (p) {
      p.classList.remove('active');
    });
    var listPage = document.getElementById('page-list');
    if (listPage) listPage.classList.add('active');
    document.querySelectorAll('.nav-btn').forEach(function (b) {
      b.classList.remove('active');
    });
  }

  function wireButton() {
    var btn = document.getElementById('btn-go-segnalare-dash');
    if (!btn || btn.dataset.wired === '1') return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      openUnsignaledList();
    });
  }

  function tick() {
    applyFuschiVisibility();
    wireButton();
    if (typeof window.updateSegnalareCount === 'function') {
      window.updateSegnalareCount();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tick);
  } else {
    tick();
  }
  setInterval(tick, 1500);

  var app = document.getElementById('app');
  if (app) {
    new MutationObserver(tick).observe(app, { attributes: true, attributeFilter: ['class'] });
  }
})();
