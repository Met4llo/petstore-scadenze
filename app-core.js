// ===== PetStore Scadenze App + Supabase =====
// VERSION 1.58 - restored full app (split core+features) + Fuschi button
const SUPABASE_URL = 'https://olfltcygpakierjzrhcr.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9sZmx0Y3lncGFraWVyanpyaGNyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYwOTQ2NzQsImV4cCI6MjEwMTY3MDY3NH0.io1m5GR7twQXQELbJQl0pz6Ok-Fk3rKyf_u4kzNHfjQ';

const DB_NAME = 'PetStoreScadenze';
const DB_VERSION = 1;
const STORE_PRODUCTS = 'products';
const STORE_META = 'meta';

let db = null;
let products = [];
let supplierConditions = {};
let currentProduct = null;
let html5QrCode = null;
let isScanning = false;
let supabase = null;
const OPERATORS = ['Santoemma', 'Fuschi', 'Pizzimenti', 'Sorrentino'];
const SUPPLIERS_LIST = ["4 HEALTHY PETS NV", "AFFINITY PETCARE ITALIA S.R.L. - DISTRIBUTORE", "AGROMARKET S.R.L.- Distributore Zoodiaco", "ALIVIT DISTRIBUZIONE SRL", "ALMO NATURE S.P.A.PETSTORE", "ASKOLL UNO SRL", "C.I.A.M.S.R.L", "CAMON&CROCI PET GROUP SPA", "COLTIVIA S.R.L.", "DORADO SRL", "FARMAZOO EMILIA SRL", "G.M.DISTRIBUZIONE S.R.L.", "GIA PET DISTRIBUTION SRLS", "GIMBORN ITALIA SRL", "GIUNTI EDITORE SPA", "HILL'S PET NUTRITION ITALIA SRL", "I.G.C. SRL", "IMAC S.R.L.", "IO VEG-CONSORZIO ETICO S.R.L. PETSTORE", "LANDINI GIUNTINI SPA", "LAVIOSA SPA", "LIFE PET CARE SRL", "MARS ITALIA S.P.A.PETSTORE", "ME PET S.R.L.", "MENNUTIGROUP DISTRIBUZIONE S.R.L.", "MONGE & C.S.P.A.PETSTORE ....", "MP GROUP S.R.L.", "MSM PET FOOD SRL", "MYFAMILY S.R.L.", "NATURAL LINE S.R.L.", "NECON PET FOOD SRL", "NESTLE' PURINA COMMERCIALE S.R.L.-PETSTORE", "NEXTMUNE ITALY SRL", "Natua s.r.l.", "OLISTIKA SRL", "PET DISTRIBUZIONE SRL", "PET VILLAGE SRL", "PETCO SRL", "PLATTO SRL", "REAL BOWL SRL", "REBO S.R.L.", "RINALDO FRANCO S.P.A.", "ROYAL CANIN ITALIA S.R.L.", "RUSSO MANGIMI S.P.A.", "SANYPET SPA", "TRE PONTI S.R.L.", "TRIXIE ITALIA SPA", "UNIPRO S.R.L.", "UNITED PETS S.r.l.", "VISAN ITALIA SRL", "VITAKRAFT ITALIA SPA PETSTORE", "WHITEBRIDGE PET BRANDS S.R.L. PETSTORE", "WONDERFOOD ITALIA SRL A SOCIO UNICO"];
let currentOperator = localStorage.getItem('petstore_operator') || null;
let bachecaMessages = [];
let tasksList = [];
let taskFilter = 'miei';
let editingTaskId = null;
let turniList = [];
let editingTurnoDate = null;
let missioneOggi = null;
let missioneProgress = [];
let missioneCompletate = [];
const MISSIONE_COUNT = 20;
const MISSIONE_HOUR = 9;
let detailReturnPage = 'dashboard';
let nonInNegozio = new Set();
let consegneList = [];
let consegneFilter = 'prossime';
let editingConsegnaId = null;

function initSupabase() {
  if (typeof window.supabase === 'undefined') {
    console.warn('Supabase library not loaded yet');
    return null;
  }
  return window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const database = e.target.result;
      if (!database.objectStoreNames.contains(STORE_PRODUCTS)) {
        const store = database.createObjectStore(STORE_PRODUCTS, { keyPath: 'ean' });
        store.createIndex('name', 'name', { unique: false });
      }
      if (!database.objectStoreNames.contains(STORE_META)) {
        database.createObjectStore(STORE_META, { keyPath: 'key' });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

function idbGetAll(storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(storeName, item) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).put(item);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function idbDelete(storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function idbBulkPut(storeName, items) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    items.forEach(item => store.put(item));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

const DEFAULT_PASSWORDS = {
  Santoemma: 'santoemma',
  Fuschi: 'fuschi',
  Pizzimenti: 'pizzimenti',
  Sorrentino: 'sorrentino'
};

async function getOperatorPassword(opName) {
  try {
    if (db) {
      const meta = await idbGetAll(STORE_META);
      const entry = (meta || []).find(m => m.key === 'pwd_' + opName);
      if (entry && entry.value) return entry.value;
    }
  } catch (e) {
    console.warn('pwd idb', e);
  }
  if (supabase) {
    try {
      const { data } = await supabase.from('operatori_pwd').select('password').eq('nome', opName).maybeSingle();
      if (data && data.password) {
        try {
          if (db) await idbPut(STORE_META, { key: 'pwd_' + opName, value: data.password });
        } catch (e) {}
        return data.password;
      }
    } catch (e) {}
  }
  return DEFAULT_PASSWORDS[opName] || '1234';
}

async function setOperatorPassword(opName, pwd) {
  await idbPut(STORE_META, { key: 'pwd_' + opName, value: pwd });
  if (supabase) {
    try {
      await supabase.from('operatori_pwd').upsert({ nome: opName, password: pwd }, { onConflict: 'nome' });
    } catch (e) {
      console.warn('Could not sync password to cloud', e);
    }
  }
}

function daysRemaining(expiryStr) {
  if (!expiryStr) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const exp = new Date(expiryStr);
  exp.setHours(0, 0, 0, 0);
  return Math.round((exp - today) / (1000 * 60 * 60 * 24));
}

function getStatusClass(days) {
  if (days === null) return '';
  if (days <= 0) return 'expired';
  if (days <= 7) return 'urgent';
  if (days <= 30) return 'attention';
  if (days <= 120) return 'monitor';
  return 'ok';
}

function getBadge(days, signaled, noExpiry) {
  if (noExpiry) return '<span class="badge no-expiry">Senza scadenza</span>';
  if (days === null) return '<span class="badge nodate">Senza data</span>';
  if (signaled) return '<span class="badge signaled">Segnalato</span>';
  if (days <= 0) return `<span class="badge expired">${days} gg</span>`;
  if (days <= 7) return `<span class="badge urgent">${days} gg</span>`;
  if (days <= 30) return `<span class="badge attention">${days} gg</span>`;
  if (days <= 120) return `<span class="badge monitor">${days} gg</span>`;
  return `<span class="badge ok">${days} gg</span>`;
}

let accessoryEans = new Set();

async function loadAccessoryEans() {
  try {
    const res = await fetch('accessory-eans.json');
    if (!res.ok) return;
    const list = await res.json();
    accessoryEans = new Set(list || []);
    console.log('Accessori senza scadenza:', accessoryEans.size);
  } catch (e) {
    console.warn('accessory-eans.json non caricato', e);
  }
}

function applyAccessoriesNoExpiry() {
  if (!accessoryEans.size) return;
  let n = 0;
  products.forEach(p => {
    if (accessoryEans.has(p.ean) && !p.expiry) {
      if (!p.noExpiry) n++;
      p.noExpiry = true;
    }
  });
  if (n) console.log('Marcati accessori senza scadenza:', n);
}

async function loadCatalog() {
  const existing = await idbGetAll(STORE_PRODUCTS);
  if (existing && existing.length > 1000) {
    products = existing.map(p => ({
      ...p,
      noExpiry: !!p.noExpiry
    }));
    console.log('Catalog from IndexedDB:', products.length);
    return;
  }
  try {
    showToast('Caricamento catalogo prodotti...');
    const res = await fetch('products.json');
    const data = await res.json();
    products = data.map(p => ({
      ean: p.ean,
      name: p.name,
      supplier: p.supplier || '',
      expiry: null,
      signaled: false,
      signaledDate: null,
      noExpiry: false,
      lastModified: null
    }));
    const chunkSize = 500;
    for (let i = 0; i < products.length; i += chunkSize) {
      await idbBulkPut(STORE_PRODUCTS, products.slice(i, i + chunkSize));
    }
    console.log('Catalog imported:', products.length);
  } catch (err) {
    console.error(err);
    showToast('Errore caricamento catalogo');
  }
}

async function loadEanRinomin() {
  if (!supabase) return;
  try {
    const { data, error } = await supabase.from('ean_rinomini').select('*');
    if (error) {
      console.warn('ean_rinomini:', error.message);
      return;
    }
    if (!data || !data.length) return;
    const direct = {};
    data.forEach(r => {
      if (r.old_ean && r.new_ean) direct[r.old_ean] = r.new_ean;
    });
    function resolve(ean) {
      let cur = ean;
      const seen = new Set();
      while (direct[cur] && !seen.has(cur)) {
        seen.add(cur);
        cur = direct[cur];
      }
      return cur;
    }
    const byEan = {};
    products.forEach(p => { byEan[p.ean] = p; });
    const next = [];
    const used = new Set();
    let renamed = 0;
    for (const p of products) {
      const finalEan = resolve(p.ean);
      if (finalEan === p.ean) {
        if (!used.has(p.ean)) {
          next.push(p);
          used.add(p.ean);
        }
        continue;
      }
      if (byEan[finalEan] && byEan[finalEan] !== p) {
        if (!used.has(finalEan)) {
          next.push(byEan[finalEan]);
          used.add(finalEan);
        }
        try { await idbDelete(STORE_PRODUCTS, p.ean); } catch (e) {}
        renamed++;
      } else {
        if (!used.has(finalEan)) {
          const old = p.ean;
          p.ean = finalEan;
          next.push(p);
          used.add(finalEan);
          try {
            await idbDelete(STORE_PRODUCTS, old);
            await idbPut(STORE_PRODUCTS, p);
          } catch (e) {}
          renamed++;
        }
      }
    }
    products = next;
    if (renamed) console.log('Applicate rinomine EAN:', renamed);
  } catch (e) {
    console.error('loadEanRinomin:', e);
  }
}

async function loadScadenzeFromCloud() {
  if (!supabase) {
    console.warn('Supabase not ready');
    return;
  }
  try {
    const { data, error } = await supabase.from('scadenze').select('*');
    if (error) {
      console.error('Supabase load error:', error);
      showToast('Errore caricamento cloud: ' + error.message);
      return;
    }
    if (!data || data.length === 0) {
      console.log('Nessuna scadenza sul cloud ancora');
      return;
    }
    const map = {};
    products.forEach(p => map[p.ean] = p);
    data.forEach(row => {
      if (map[row.ean]) {
        map[row.ean].expiry = row.expiry || null;
        map[row.ean].signaled = !!row.signaled;
        map[row.ean].signaledDate = row.signaled_date || null;
        map[row.ean].noExpiry = !!row.no_expiry;
        map[row.ean].lastModified = row.last_modified ? new Date(row.last_modified).getTime() : null;
        map[row.ean].updatedBy = row.updated_by || null;
      }
    });
    products = Object.values(map);
    applyAccessoriesNoExpiry();
    console.log('Merged', data.length, 'scadenze from Supabase');
    showToast(`Sincronizzate ${data.length} scadenze`);
  } catch (err) {
    console.error(err);
    showToast('Errore di rete verso Supabase');
  }
}

async function loadSupplierConditions() {
  try {
    const res = await fetch('supplier-conditions.json');
    supplierConditions = await res.json();
  } catch (e) {
    console.warn('Could not load supplier conditions');
  }
}

async function saveToCloud(product) {
  if (!supabase) {
    console.error('supabase client is null');
    showToast('Cloud non disponibile - libreria non caricata');
    return false;
  }
  try {
    const payload = {
      ean: product.ean,
      expiry: product.noExpiry ? null : (product.expiry || null),
      signaled: product.noExpiry ? false : !!product.signaled,
      signaled_date: product.noExpiry ? null : (product.signaledDate || null),
      no_expiry: !!product.noExpiry,
      last_modified: new Date().toISOString(),
      updated_by: currentOperator || 'Sconosciuto'
    };
    console.log('Saving to Supabase:', payload);
    const { data, error } = await supabase.from('scadenze').upsert(payload, { onConflict: 'ean' }).select();
    if (error) {
      console.error('Supabase save error:', error);
      showToast('Errore cloud: ' + (error.message || JSON.stringify(error)));
      return false;
    }
    console.log('Save success:', data);
    return true;
  } catch (err) {
    console.error('Save exception:', err);
    showToast('Errore di rete: ' + err.message);
    return false;
  }
}

function findCondition(supplierName) {
  if (!supplierName) return null;
  const name = supplierName.toUpperCase();
  for (const [key, val] of Object.entries(supplierConditions)) {
    if (name.includes(key.toUpperCase()) || key.toUpperCase().includes(name.split(' ')[0])) {
      return val;
    }
  }
  const map = {
    '4 HEALTHY': '4 HEALTHY PETS (EDGARD COOPER)',
    'EDGARD': '4 HEALTHY PETS (EDGARD COOPER)',
    'CAMON': 'CAMON&CROCI PET GROUP SPA',
    'CROCI': 'CAMON&CROCI PET GROUP SPA',
    'AFFINITY': 'AFFINITY (TRAINER)',
    'TRAINER': 'AFFINITY (TRAINER)',
    'TRIXIE': 'TRIXIE ITALIA SPA',
    'MONGE': 'MONGE',
    'HILL': "HILL'S PET NUTRITION ITALIA S.R.L",
    'WONDERFOOD': 'WONDERFOOD',
    'OASY': 'WONDERFOOD',
    'ACANA': 'WONDERFOOD',
    'ORIJEN': 'WONDERFOOD',
    'VITAKRAFT': 'VITAKRAFT',
    'ALMO': 'ALMO NATURE S.P.A.',
    'SANYPET': 'SANYPET SRL',
    'OLISTIKA': 'OLISTIKA',
    'NEXTMUNE': 'NEXTMUNE',
    'UNIPRO': 'UNIPRO',
    'VISAN': 'VISAN',
    'REBO': 'REBO SRL (HAPPYDOG)',
    'HAPPYDOG': 'REBO SRL (HAPPYDOG)',
    'PLATTO': 'PLATTO SRL (DOGGYEBAG)',
    'TRE PONTI': 'TRE PONTI',
    'RINALDO': 'RINALDO FRANCO',
    'FARMINA': 'RUSSO MANGIMI FARMINA',
    'RUSSO': 'RUSSO MANGIMI FARMINA'
  };
  for (const [k, v] of Object.entries(map)) {
    if (name.includes(k)) return supplierConditions[v] || null;
  }
  return null;
}

function showToast(msg, duration = 2800) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), duration);
}

function showPage(pageId) {
  if (pageId === 'ordini' && currentOperator !== 'Santoemma') {
    showToast('Sezione riservata a Santoemma');
    pageId = 'dashboard';
  }
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const page = document.getElementById('page-' + pageId);
  if (page) page.classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.page === pageId);
  });
  if (pageId !== 'scanner' && isScanning) stopScanner();
}

function renderProductCard(p) {
  const days = p.noExpiry ? null : daysRemaining(p.expiry);
  const cls = p.noExpiry ? 'ok' : getStatusClass(days);
  const by = p.updatedBy ? `<span class="modified-by">${escapeHtml(p.updatedBy)}</span>` : '';
  const supplier = p.supplier ? escapeHtml(p.supplier) : '';
  return `
    <div class="product-card ${cls}" data-ean="${p.ean}">
      <div class="product-card-top">
        <div class="product-name">${escapeHtml(p.name)}</div>
        ${getBadge(days, p.signaled, p.noExpiry)}
      </div>
      <div class="product-meta">
        ${supplier ? `<span class="product-supplier">${supplier}</span>` : ''}
        ${by}
        <span class="product-ean">${escapeHtml(p.ean)}</span>
      </div>
    </div>
  `;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&').replace(/</g,'<').replace(/>/g,'>').replace(/"/g,'"');
}

function updateDashboard() {
  const withDate = products.filter(p => p.expiry && !p.noExpiry);
  const urgent = withDate.filter(p => { const d = daysRemaining(p.expiry); return d > 0 && d <= 7; });
  const attention = withDate.filter(p => { const d = daysRemaining(p.expiry); return d > 7 && d <= 30; });
  const monitor = withDate.filter(p => { const d = daysRemaining(p.expiry); return d > 30 && d <= 120; });

  const grid = document.getElementById('stats-grid');
  if (!grid) return;
  grid.innerHTML = `
    <div class="stat-card urgent" data-filter="urgent">
      <div class="count">${urgent.length}</div>
      <div class="label">7 giorni</div>
    </div>
    <div class="stat-card attention" data-filter="attention">
      <div class="count">${attention.length}</div>
      <div class="label">30 giorni</div>
    </div>
    <div class="stat-card monitor" data-filter="monitor">
      <div class="count">${monitor.length}</div>
      <div class="label">120 giorni</div>
    </div>
  `;

  document.querySelectorAll('.stat-card').forEach(card => {
    card.onclick = () => {
      const lf = document.getElementById('list-filter');
      if (lf) lf.value = card.dataset.filter;
      showPage('list');
      renderFilteredList(card.dataset.filter);
    };
  });
}

function renderFilteredList(filter) {
  let list;
  if (filter === 'all' || filter === 'no-date') {
    list = products.filter(p => !p.expiry && !p.noExpiry);
  } else if (filter === 'with-date') {
    list = products.filter(p => p.expiry && !p.noExpiry);
  } else if (filter === 'expired') {
    list = products.filter(p => p.expiry && !p.noExpiry && daysRemaining(p.expiry) <= 0);
  } else if (filter === 'urgent') {
    list = products.filter(p => {
      if (!p.expiry || p.noExpiry) return false;
      const d = daysRemaining(p.expiry);
      return d > 0 && d <= 7;
    });
  } else if (filter === 'attention') {
    list = products.filter(p => {
      if (!p.expiry || p.noExpiry) return false;
      const d = daysRemaining(p.expiry);
      return d > 7 && d <= 30;
    });
  } else if (filter === 'monitor') {
    list = products.filter(p => {
      if (!p.expiry || p.noExpiry) return false;
      const d = daysRemaining(p.expiry);
      return d > 30 && d <= 120;
    });
  } else if (filter === 'unsignaled') {
    list = products.filter(p => {
      if (!p.expiry || p.noExpiry || p.signaled) return false;
      const d = daysRemaining(p.expiry);
      return d !== null && d <= 120;
    });
  } else if (filter === 'signaled') {
    list = products.filter(p => p.signaled && !p.noExpiry);
  } else if (filter === 'no-expiry') {
    list = products.filter(p => p.noExpiry);
  } else {
    list = products.filter(p => !p.expiry && !p.noExpiry);
  }

  if (filter === 'all' || filter === 'no-date' || filter === 'no-expiry') {
    list.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'it'));
  } else {
    list.sort((a, b) => (daysRemaining(a.expiry) || 9999) - (daysRemaining(b.expiry) || 9999));
  }

  const titles = {
    expired: 'Prodotti scaduti',
    urgent: 'Urgenti (≤7 giorni)',
    attention: 'Attenzione (≤30 giorni)',
    monitor: 'Da monitorare (≤120 giorni)',
    unsignaled: 'Non segnalati',
    signaled: 'Solo segnalati',
    'no-expiry': 'Senza scadenza (esclusi dal controllo)',
    'with-date': 'Con data inserita',
    'no-date': 'Senza data di scadenza',
    all: 'Senza data di scadenza'
  };
  const titleEl = document.getElementById('list-title');
  if (titleEl) titleEl.textContent = titles[filter] || 'Lista prodotti';

  const container = document.getElementById('filtered-list');
  if (!container) return;
  if (list.length === 0) {
    container.innerHTML = '<p style="color:#64748b;text-align:center;padding:20px;">Nessun prodotto in questa categoria</p>';
  } else {
    container.innerHTML = list.slice(0, 300).map(renderProductCard).join('') +
      (list.length > 300 ? `<p style="text-align:center;color:#64748b;">... e altri ${list.length - 300}</p>` : '');
  }
  container.querySelectorAll('.product-card').forEach(card => {
    card.onclick = () => openProduct(card.dataset.ean, 'list');
  });
}

function doSearch(query) {
  query = query.trim().toLowerCase();
  if (query.length < 2) {
    const el = document.getElementById('search-results');
    if (el) el.innerHTML = '';
    return;
  }
  const results = products.filter(p =>
    p.ean.includes(query) || p.name.toLowerCase().includes(query)
  ).slice(0, 50);

  const container = document.getElementById('search-results');
  if (!container) return;
  container.innerHTML = results.length
    ? results.map(renderProductCard).join('')
    : '<p style="color:#64748b;text-align:center;">Nessun risultato</p>';
  container.querySelectorAll('.product-card').forEach(card => {
    card.onclick = () => openProduct(card.dataset.ean, 'scanner');
  });
}

// Product detail, save, delete, scanner, export/import, sync, login helpers
// (continued in app-features.js for the remaining sections)

window.__petstoreCoreLoaded = true;
console.log('PetStore core v1.58 loaded');
