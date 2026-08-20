// ===== PetStore Scadenze App + Supabase =====
// VERSION 1.53 - password per operatore + bacheca + task
const SUPABASE_URL = 'https://olfltcygpakierjzrhcr.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9sZmx0Y3lncGFraWVyanpyaGNyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYwOTQ2NzQsImV4cCI6MjEwMTY3MDY3NH0.io1m5GR7twQXQELbJQl0pz6Ok-Fk3rKyf_u4kzNHfjQ';

const DB_NAME = 'PetStoreScadenze';
const DB_VERSION = 1;
const STORE_PRODUCTS = 'products';
const STORE_META = 'meta';

let db = null;
let products = [];          // full catalog + merged scadenze
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
const MISSIONE_COUNT = 20; // obiettivo: coprire tutti i prodotti senza data in 3-4 mesi
const MISSIONE_HOUR = 9;
let detailReturnPage = 'dashboard';
let nonInNegozio = new Set(); // EANs not in store
let consegneList = [];
let consegneFilter = 'prossime';
let editingConsegnaId = null;

// ---------- Supabase init ----------
function initSupabase() {
  if (typeof window.supabase === 'undefined') {
    console.warn('Supabase library not loaded yet');
    return null;
  }
  return window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

// ---------- IndexedDB (for offline catalog cache) ----------
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

// ---------- Password ----------
// Default passwords (operator can change their own)
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
  // Try Supabase
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

// ---------- Days calculation ----------
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

// ---------- Load catalog (static) ----------
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
    // Solo se non ha già una data e non è già gestito dal cloud come noExpiry false con expiry
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

// ---------- Rinomina EAN persistenti (cloud) ----------
async function loadEanRinomin() {
  if (!supabase) return;
  try {
    const { data, error } = await supabase.from('ean_rinomini').select('*');
    if (error) {
      // Tabella assente: non bloccare l'app
      console.warn('ean_rinomini:', error.message);
      return;
    }
    if (!data || !data.length) return;

    // Mappa old → new e risolvi catene A→B→C
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
      // Prodotto rinominato
      if (byEan[finalEan] && byEan[finalEan] !== p) {
        // Esiste già il nuovo: scarta il vecchio
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

// ---------- Load scadenze from Supabase ----------
async function loadScadenzeFromCloud() {
  if (!supabase) {
    console.warn('Supabase not ready');
    return;
  }
  try {
    const { data, error } = await supabase
      .from('scadenze')
      .select('*');
    if (error) {
      console.error('Supabase load error:', error);
      showToast('Errore caricamento cloud: ' + error.message);
      return;
    }
    if (!data || data.length === 0) {
      console.log('Nessuna scadenza sul cloud ancora');
      return;
    }
    // Merge into products
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
    // Accessori (guinzagli, giochi, ecc.): senza scadenza se non hanno data
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

// ---------- Save to Supabase ----------
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
    const { data, error } = await supabase
      .from('scadenze')
      .upsert(payload, { onConflict: 'ean' })
      .select();
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

// ---------- Find condition ----------
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

// ---------- UI Helpers ----------
function showToast(msg, duration = 2800) {
  const t = document.getElementById('toast');
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
  document.getElementById('page-' + pageId).classList.add('active');
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
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ---------- Dashboard ----------
function updateDashboard() {
  // Esclude prodotti registrati come "senza scadenza"
  const withDate = products.filter(p => p.expiry && !p.noExpiry);
  const expired = withDate.filter(p => daysRemaining(p.expiry) <= 0);
  const urgent = withDate.filter(p => { const d = daysRemaining(p.expiry); return d > 0 && d <= 7; });
  const attention = withDate.filter(p => { const d = daysRemaining(p.expiry); return d > 7 && d <= 30; });
  const monitor = withDate.filter(p => { const d = daysRemaining(p.expiry); return d > 30 && d <= 120; });
  const unsignaled = withDate.filter(p => {
    const d = daysRemaining(p.expiry);
    return d !== null && d <= 120 && !p.signaled;
  });

  document.getElementById('stats-grid').innerHTML = `
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
      document.getElementById('list-filter').value = card.dataset.filter;
      showPage('list');
      renderFilteredList(card.dataset.filter);
    };
  });
}

// ---------- List / Filter ----------
function renderFilteredList(filter) {
  let list;
  if (filter === 'all' || filter === 'no-date') {
    // Prodotti ancora senza data di scadenza (da completare) — esclusi i "senza scadenza" definitivi
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
  document.getElementById('list-title').textContent = titles[filter] || 'Lista prodotti';

  const container = document.getElementById('filtered-list');
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

// ---------- Search ----------
function doSearch(query) {
  query = query.trim().toLowerCase();
  if (query.length < 2) {
    document.getElementById('search-results').innerHTML = '';
    return;
  }
  const results = products.filter(p =>
    p.ean.includes(query) || p.name.toLowerCase().includes(query)
  ).slice(0, 50);

  const container = document.getElementById('search-results');
  container.innerHTML = results.length
    ? results.map(renderProductCard).join('')
    : '<p style="color:#64748b;text-align:center;">Nessun risultato</p>';
  container.querySelectorAll('.product-card').forEach(card => {
    card.onclick = () => openProduct(card.dataset.ean, 'scanner');
  });
}

// ---------- Product Detail ----------
function openProduct(ean, returnPage) {
  if (returnPage) detailReturnPage = returnPage;
  else if (!detailReturnPage) detailReturnPage = 'dashboard';
  currentProduct = products.find(p => p.ean === ean);
  if (!currentProduct) {
    showToast('Prodotto non trovato');
    return;
  }
  const days = daysRemaining(currentProduct.expiry);
  const condition = findCondition(currentProduct.supplier);

  const isNoExp = !!currentProduct.noExpiry;
  document.getElementById('product-detail').innerHTML = `
    <div class="detail-block">
      <p class="detail-kicker">Prodotto</p>
      <div class="detail-name">${escapeHtml(currentProduct.name)}</div>
      <div class="detail-row">
        <label>EAN</label>
        <input type="text" id="detail-ean" inputmode="numeric" pattern="[0-9]*" value="${escapeHtml(currentProduct.ean || '')}" autocomplete="off">
        <p class="field-hint">Se cambi l'EAN, i dati scadenza restano sul nuovo codice</p>
      </div>
      <div class="supplier-box">
        <label>Fornitore</label>
        <div class="supplier-value">${escapeHtml(currentProduct.supplier) || 'Non specificato'}</div>
        ${condition ? `<div class="conditions-text"><strong>Condizioni reso</strong><br>${escapeHtml(condition)}</div>` : '<div class="conditions-text">Condizioni non trovate nel database fornitori</div>'}
      </div>
    </div>

    <div class="detail-block">
      <p class="detail-kicker">Scadenza</p>
      <div class="detail-row">
        <label class="check-label no-expiry-label">
          <input type="checkbox" id="detail-no-expiry" ${isNoExp ? 'checked' : ''}>
          <span>Prodotto senza scadenza<br><small>Resta registrato, escluso dai controlli</small></span>
        </label>
      </div>
      <div id="expiry-fields" style="${isNoExp ? 'display:none' : ''}">
        <div class="detail-row">
          <label>Data di scadenza</label>
          <input type="date" id="detail-expiry" value="${currentProduct.expiry || ''}">
        </div>
        <div class="days-display ${getStatusClass(days)}" id="detail-days">
          ${days === null ? 'Nessuna data' : (days <= 0 ? `Scaduto da ${Math.abs(days)} giorni` : `${days} giorni rimanenti`)}
        </div>
        <div class="detail-row">
          <label>Stato</label>
          <select id="detail-signaled">
            <option value="false" ${!currentProduct.signaled ? 'selected' : ''}>Non segnalato</option>
            <option value="true" ${currentProduct.signaled ? 'selected' : ''}>Segnalato</option>
          </select>
        </div>
        <div class="detail-row" id="signaled-date-row" style="${currentProduct.signaled ? '' : 'display:none'}">
          <label>Data di segnalazione</label>
          <input type="date" id="detail-signaled-date" value="${currentProduct.signaledDate || ''}">
          <p class="field-hint">Obbligatoria se il prodotto è segnalato</p>
        </div>
      </div>
      <div class="modified-by" id="detail-modified-by">
        ${currentProduct.updatedBy ? 'Ultima modifica di <strong>' + escapeHtml(currentProduct.updatedBy) + '</strong>' : 'Nessuna modifica registrata'}
      </div>
    </div>

    <div class="detail-block detail-block-actions">
      <button id="btn-toggle-non-negozio" class="btn btn-secondary btn-large">
        ${nonInNegozio.has(currentProduct.ean) ? 'Segna come in negozio' : 'Segna come non in negozio'}
      </button>
      <button id="btn-delete-product" class="btn btn-danger btn-large" style="margin-top:8px;">Elimina prodotto</button>
    </div>

    <div class="detail-save-bar">
      <button id="btn-save-product" class="btn btn-primary btn-large">Salva modifiche</button>
    </div>
  `;

  const noExpCb = document.getElementById('detail-no-expiry');
  if (noExpCb) {
    noExpCb.addEventListener('change', () => {
      const fields = document.getElementById('expiry-fields');
      if (fields) fields.style.display = noExpCb.checked ? 'none' : '';
    });
  }

  const expiryInput = document.getElementById('detail-expiry');
  if (expiryInput) {
    expiryInput.addEventListener('change', (e) => {
      const d = daysRemaining(e.target.value);
      const el = document.getElementById('detail-days');
      if (!el) return;
      el.className = 'days-display ' + getStatusClass(d);
      el.textContent = d === null ? 'Nessuna data' : (d <= 0 ? `Scaduto da ${Math.abs(d)} giorni` : `${d} giorni rimanenti`);
    });
  }

  const sigSel = document.getElementById('detail-signaled');
  if (sigSel) {
    sigSel.addEventListener('change', (e) => {
      const row = document.getElementById('signaled-date-row');
      if (!row) return;
      if (e.target.value === 'true') {
        row.style.display = '';
        const dateInput = document.getElementById('detail-signaled-date');
        if (dateInput && !dateInput.value) {
          dateInput.value = new Date().toISOString().slice(0, 10);
        }
      } else {
        row.style.display = 'none';
      }
    });
  }

  document.getElementById('btn-save-product').onclick = saveProduct;
  document.getElementById('btn-delete-product').onclick = deleteProduct;
  const btnNonNeg = document.getElementById('btn-toggle-non-negozio');
  if (btnNonNeg) btnNonNeg.onclick = () => toggleNonInNegozio(currentProduct.ean);
  showPage('detail');
}

async function saveProduct() {
  if (!currentProduct) return;
  const oldEan = currentProduct.ean;
  const eanInput = document.getElementById('detail-ean');
  const newEan = ((eanInput && eanInput.value) || '').trim().replace(/\D/g, '');
  const noExpiry = !!(document.getElementById('detail-no-expiry') && document.getElementById('detail-no-expiry').checked);
  const expiryEl = document.getElementById('detail-expiry');
  const expiry = noExpiry ? null : ((expiryEl && expiryEl.value) || null);
  const sigEl = document.getElementById('detail-signaled');
  const signaled = noExpiry ? false : (sigEl && sigEl.value === 'true');
  const signaledDateInput = document.getElementById('detail-signaled-date');
  const signaledDate = noExpiry ? null : (signaledDateInput ? (signaledDateInput.value || null) : null);

  if (!newEan || newEan.length < 5) {
    showToast('Inserisci un EAN valido (solo numeri)');
    if (eanInput) eanInput.focus();
    return;
  }

  if (!noExpiry && signaled && !signaledDate) {
    showToast('Inserisci la Data di segnalazione (obbligatoria)');
    if (signaledDateInput) signaledDateInput.focus();
    return;
  }

  // EAN cambiato: controlla duplicati
  if (newEan !== oldEan) {
    const exists = products.find(p => p.ean === newEan);
    if (exists) {
      showToast('Questo EAN è già usato da: ' + (exists.name || newEan));
      return;
    }
  }

  currentProduct.noExpiry = noExpiry;
  currentProduct.expiry = expiry;
  currentProduct.signaled = signaled;
  currentProduct.signaledDate = signaled ? signaledDate : null;
  currentProduct.lastModified = Date.now();
  currentProduct.updatedBy = currentOperator || 'Sconosciuto';
  currentProduct.ean = newEan;

  const idx = products.findIndex(p => p.ean === oldEan || p.ean === newEan);
  if (idx >= 0) products[idx] = currentProduct;
  else products.push(currentProduct);

  // Aggiorna set non-in-negozio se EAN cambiato
  if (newEan !== oldEan && nonInNegozio.has(oldEan)) {
    nonInNegozio.delete(oldEan);
    nonInNegozio.add(newEan);
  }

  if (!supabase) {
    showToast('ERRORE: Client Supabase non inizializzato. Ricarica la pagina.');
    updateDashboard();
    return;
  }

  showToast('Salvataggio su cloud in corso...');
  let ok = true;

  if (newEan !== oldEan) {
    // 1) Dati scadenza sul nuovo EAN
    ok = await saveToCloud(currentProduct);
    if (ok) {
      // 2) Elimina scadenza sul vecchio EAN
      try {
        await supabase.from('scadenze').delete().eq('ean', oldEan);
      } catch (e) {
        console.error('delete old ean scadenze:', e);
      }

      // 3) Anagrafica sul nuovo EAN (sempre, così tutti i dispositivi lo vedono)
      try {
        await supabase.from('prodotti_custom').upsert({
          ean: newEan,
          name: currentProduct.name || '',
          supplier: currentProduct.supplier || '',
          created_by: currentOperator || 'Sconosciuto'
        }, { onConflict: 'ean' });
        await supabase.from('prodotti_custom').delete().eq('ean', oldEan);
      } catch (e) {
        console.error('prodotti_custom rename:', e);
      }

      // 4) Mappa rinomina EAN (persistente su cloud per tutti)
      try {
        await supabase.from('ean_rinomini').upsert({
          old_ean: oldEan,
          new_ean: newEan,
          updated_by: currentOperator || 'Sconosciuto',
          updated_at: new Date().toISOString()
        }, { onConflict: 'old_ean' });
        // Catena: se qualcuno puntava già a oldEan come new_ean, aggiorna a newEan
        await supabase.from('ean_rinomini').update({
          new_ean: newEan,
          updated_at: new Date().toISOString()
        }).eq('new_ean', oldEan);
      } catch (e) {
        console.error('ean_rinomini:', e);
        showToast('Attenzione: mappa EAN non salvata (crea tabella ean_rinomini)');
      }

      // 5) non in negozio
      try {
        const { data: nn } = await supabase.from('prodotti_non_in_negozio').select('*').eq('ean', oldEan);
        if (nn && nn.length) {
          await supabase.from('prodotti_non_in_negozio').upsert({
            ean: newEan,
            updated_by: currentOperator || 'Sconosciuto',
            updated_at: new Date().toISOString()
          }, { onConflict: 'ean' });
          await supabase.from('prodotti_non_in_negozio').delete().eq('ean', oldEan);
        }
      } catch (e) {
        console.error('move non_in_negozio:', e);
      }

      // 6) IndexedDB locale: rimuovi vecchio, salva nuovo (altrimenti al reload torna indietro)
      try {
        await idbDelete(STORE_PRODUCTS, oldEan);
        await idbPut(STORE_PRODUCTS, currentProduct);
      } catch (e) {
        console.error('idb rename:', e);
      }
    }
  } else {
    ok = await saveToCloud(currentProduct);
    try {
      await idbPut(STORE_PRODUCTS, currentProduct);
    } catch (e) {}
  }

  if (ok) {
    showToast(newEan !== oldEan ? 'EAN aggiornato e salvato!' : 'Salvato e sincronizzato!');
  }
  updateDashboard();
  detailReturnPage = 'scanner';
  showPage('scanner');
}


async function deleteProduct() {
  if (!currentProduct) return;

  const nome = currentProduct.name || currentProduct.ean;
  const ok = confirm(
    'Eliminare questo prodotto dal database?\n\n' +
    nome + '\nEAN: ' + currentProduct.ean + '\n\n' +
    'L\'operazione non si può annullare.'
  );
  if (!ok) return;

  const ean = currentProduct.ean;
  showToast('Eliminazione in corso...');

  // Remove from Supabase scadenze
  if (supabase) {
    try {
      const { error } = await supabase.from('scadenze').delete().eq('ean', ean);
      if (error) console.error('scadenze delete error:', error);
    } catch (e) {
      console.error(e);
    }
    // Remove from prodotti_custom if present
    try {
      const { error } = await supabase.from('prodotti_custom').delete().eq('ean', ean);
      if (error) console.error('prodotti_custom delete error:', error);
    } catch (e) {
      console.error(e);
    }
  }

  // Remove from local array
  products = products.filter(p => p.ean !== ean);

  // Remove from IndexedDB
  try {
    await idbDelete(STORE_PRODUCTS, ean);
  } catch (e) {
    console.error('IndexedDB delete error:', e);
  }

  currentProduct = null;
  showToast('Prodotto eliminato');
  updateDashboard();
  showPage('dashboard');
}

// ---------- Scanner ----------
async function startScanner() {
  if (isScanning) return;
  const reader = document.getElementById('reader');
  reader.innerHTML = '';
  html5QrCode = new Html5Qrcode('reader');
  try {
    await html5QrCode.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 280, height: 150 } },
      onScanSuccess,
      () => {}
    );
    isScanning = true;
    document.getElementById('btn-stop-scanner').classList.remove('hidden');
    const bs = document.getElementById('btn-start-scanner');
    if (bs) bs.classList.add('hidden');
  } catch (err) {
    console.error(err);
    showToast('Impossibile avviare la fotocamera. Controlla i permessi.');
  }
}

async function stopScanner() {
  if (html5QrCode && isScanning) {
    try { await html5QrCode.stop(); } catch (e) {}
    isScanning = false;
    document.getElementById('btn-stop-scanner').classList.add('hidden');
    const btnStart = document.getElementById('btn-start-scanner');
    if (btnStart) btnStart.classList.remove('hidden');
  }
}

function onScanSuccess(decodedText) {
  const ean = decodedText.replace(/\D/g, '');
  stopScanner();
  const product = products.find(p => p.ean === ean || p.ean === decodedText);
  if (product) {
    openProduct(product.ean);
  } else {
    document.getElementById('scan-result').classList.remove('hidden');
    document.getElementById('scan-result').innerHTML = `
      <p><strong>Codice scansionato:</strong> ${escapeHtml(decodedText)}</p>
      <p style="color:var(--danger);margin-top:8px;">Prodotto non trovato nel database.</p>
      <button class="btn btn-secondary" style="margin-top:12px;" onclick="document.getElementById('scan-result').classList.add('hidden');startScanner();">Riprova</button>
    `;
  }
}

// ---------- Export / Import (backup) ----------
function exportData() {
  const data = products.filter(p => p.expiry || p.signaled || p.lastModified);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `scadenze-backup-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Backup esportato');
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const imported = JSON.parse(e.target.result);
      let count = 0;
      for (const item of imported) {
        const existing = products.find(p => p.ean === item.ean);
        if (existing) {
          existing.expiry = item.expiry || existing.expiry;
          existing.signaled = item.signaled || existing.signaled;
          existing.signaledDate = item.signaledDate || existing.signaledDate;
          existing.lastModified = item.lastModified || Date.now();
          await saveToCloud(existing);
          count++;
        }
      }
      showToast(`Importati e sincronizzati ${count} aggiornamenti`);
      updateDashboard();
    } catch (err) {
      showToast('File non valido');
    }
  };
  reader.readAsText(file);
}

// ---------- Sync button ----------
const AUTO_SYNC_MS = 5 * 60 * 1000; // 5 minuti
let autoSyncTimer = null;
let autoSyncRunning = false;

async function runSync(silent) {
  if (autoSyncRunning) return;
  if (!supabase || !currentOperator) return;
  autoSyncRunning = true;
  try {
    if (!silent) showToast('Sincronizzazione in corso...');
    await loadEanRinomin();
    await loadCustomProducts();
    await loadScadenzeFromCloud();
    applyAccessoriesNoExpiry();
    await loadBacheca();
    await loadTasks();
    await loadTurni();
    await refreshMissione();
    await loadNonInNegozio();
    await loadConsegne();
    updateDashboard();
    updateMyTasksAlert();
    if (!silent) showToast('Sincronizzazione completata');
  } catch (e) {
    console.error('Sync error:', e);
    if (!silent) showToast('Errore sincronizzazione');
  } finally {
    autoSyncRunning = false;
  }
}

async function manualSync() {
  await runSync(false);
}

function startAutoSync() {
  stopAutoSync();
  autoSyncTimer = setInterval(() => {
    if (document.hidden) return; // risparmia batteria se app in background
    if (!currentOperator) return;
    runSync(true); // silenziosa, senza toast
  }, AUTO_SYNC_MS);
  console.log('Auto-sync avviato ogni 5 minuti');
}

function stopAutoSync() {
  if (autoSyncTimer) {
    clearInterval(autoSyncTimer);
    autoSyncTimer = null;
  }
}

function enterApp() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('password-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  updateOperatorUI();
  updateDashboard();
  loadBacheca();
  loadTasks().then(() => notifyTasksOnLogin());
  loadTurni();
  refreshMissione();
  loadNonInNegozio();
  loadConsegne();
  startAutoSync();
}

function updateOperatorUI() {
  const el = document.getElementById('current-operator');
  if (el) el.textContent = currentOperator || '';
  const settingsName = document.getElementById('settings-operator-name');
  if (settingsName) settingsName.textContent = currentOperator || 'Nessuno';
  // Sezione ordini: solo Santoemma
  document.querySelectorAll('.menu-santoemma-only').forEach(btn => {
    if (currentOperator === 'Santoemma') btn.classList.remove('hidden');
    else btn.classList.add('hidden');
  });
}

let pendingOperator = null;

function selectOperator(name) {
  // Show password screen for this operator (do not enter yet)
  pendingOperator = name;
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('password-screen').classList.remove('hidden');
  document.getElementById('pwd-operator-name').textContent = name;
  document.getElementById('login-password').value = '';
  document.getElementById('login-error').classList.add('hidden');
  setTimeout(() => document.getElementById('login-password').focus(), 100);
}

function logoutToOperators() {
  stopAutoSync();
  currentOperator = null;
  pendingOperator = null;
  localStorage.removeItem('petstore_operator');
  document.getElementById('app').classList.add('hidden');
  document.getElementById('password-screen').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('login-password').value = '';
}


function populateSupplierSelect() {
  const sel = document.getElementById('add-supplier');
  if (!sel || sel.options.length > 1) return;
  SUPPLIERS_LIST.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s;
    sel.appendChild(opt);
  });
}

async function saveNewProduct() {
  const ean = (document.getElementById('add-ean').value || '').trim().replace(/\D/g, '');
  const name = (document.getElementById('add-name').value || '').trim();
  const supplier = document.getElementById('add-supplier').value || '';
  const expiry = document.getElementById('add-expiry').value || null;
  const msg = document.getElementById('add-product-msg');

  if (!ean || ean.length < 5) {
    msg.textContent = 'Inserisci un EAN valido';
    msg.className = 'msg error';
    msg.classList.remove('hidden');
    return;
  }
  if (!name) {
    msg.textContent = 'Inserisci il nome del prodotto';
    msg.className = 'msg error';
    msg.classList.remove('hidden');
    return;
  }
  if (!supplier) {
    msg.textContent = 'Seleziona un fornitore';
    msg.className = 'msg error';
    msg.classList.remove('hidden');
    return;
  }

  // Check if already exists
  const existing = products.find(p => p.ean === ean);
  if (existing) {
    msg.textContent = 'Questo EAN esiste già: ' + existing.name;
    msg.className = 'msg error';
    msg.classList.remove('hidden');
    return;
  }

  const newProduct = {
    ean: ean,
    name: name,
    supplier: supplier,
    expiry: expiry,
    signaled: false,
    signaledDate: null,
    lastModified: Date.now(),
    updatedBy: currentOperator || 'Sconosciuto',
    isCustom: true
  };

  // Save to Supabase prodotti_custom
  if (supabase) {
    try {
      const { error } = await supabase.from('prodotti_custom').upsert({
        ean: ean,
        name: name,
        supplier: supplier,
        created_by: currentOperator || 'Sconosciuto',
        created_at: new Date().toISOString()
      }, { onConflict: 'ean' });
      if (error) {
        console.error(error);
        // If table doesn't exist, still save locally
        if (error.message && error.message.includes('does not exist')) {
          showToast('Tabella prodotti_custom non trovata - salvato solo in locale');
        } else {
          msg.textContent = 'Errore cloud: ' + error.message;
          msg.className = 'msg error';
          msg.classList.remove('hidden');
          return;
        }
      }
    } catch (err) {
      console.error(err);
    }
  }

  // If has expiry, also save to scadenze
  if (expiry && supabase) {
    await saveToCloud(newProduct);
  }

  products.push(newProduct);
  try { await idbPut(STORE_PRODUCTS, newProduct); } catch(e) {}

  msg.textContent = 'Prodotto aggiunto!';
  msg.className = 'msg success';
  msg.classList.remove('hidden');
  showToast('Prodotto aggiunto');

  // Clear form
  document.getElementById('add-ean').value = '';
  document.getElementById('add-name').value = '';
  document.getElementById('add-supplier').value = '';
  document.getElementById('add-expiry').value = '';

  setTimeout(() => {
    openProduct(ean);
  }, 600);
}

async function loadCustomProducts() {
  if (!supabase) return;
  try {
    const { data, error } = await supabase.from('prodotti_custom').select('*');
    if (error || !data) return;
    let added = 0;
    data.forEach(row => {
      if (!products.find(p => p.ean === row.ean)) {
        products.push({
          ean: row.ean,
          name: row.name,
          supplier: row.supplier || '',
          expiry: null,
          signaled: false,
          signaledDate: null,
          lastModified: null,
          updatedBy: row.created_by || null,
          isCustom: true
        });
        added++;
      }
    });
    if (added > 0) {
      console.log('Loaded', added, 'custom products from cloud');
    }
  } catch (e) {
    console.warn('Could not load custom products', e);
  }
}



// ========== BACHECA ==========
async function loadBacheca() {
  if (!supabase) return;
  try {
    const { data, error } = await supabase
      .from('bacheca')
      .select('*')
      .order('fixed', { ascending: false })
      .order('created_at', { ascending: false });
    if (error) {
      console.error('bacheca load:', error);
      return;
    }
    bachecaMessages = data || [];
    renderBacheca();
  } catch (e) {
    console.error(e);
  }
}

function renderBacheca() {
  const el = document.getElementById('bacheca-list');
  if (!el) return;
  if (!bachecaMessages.length) {
    el.innerHTML = '<p class="muted-center">Nessun messaggio in bacheca</p>';
    return;
  }
  const shown = bachecaMessages.slice(0, 2);
  const extra = bachecaMessages.length - shown.length;
  el.innerHTML = shown.map(m => {
    const date = m.created_at ? new Date(m.created_at).toLocaleString('it-IT', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }) : '';
    return `<div class="bacheca-item ${m.fixed ? 'fixed' : ''}">
      <div>${escapeHtml(m.testo)}</div>
      <div class="bacheca-meta">
        <span>${escapeHtml(m.created_by || '')} · ${date}${m.fixed ? ' · in evidenza' : ''}</span>
        <button class="bacheca-del" data-id="${m.id}">Elimina</button>
      </div>
    </div>`;
  }).join('') + (extra > 0 ? `<p class="bacheca-more">${extra} altri messaggi</p>` : '');
  el.querySelectorAll('.bacheca-del').forEach(btn => {
    btn.onclick = () => deleteBacheca(btn.dataset.id);
  });
}

async function saveBacheca() {
  const testo = (document.getElementById('bacheca-text').value || '').trim();
  if (!testo) {
    showToast('Scrivi un messaggio');
    return;
  }
  if (!supabase) {
    showToast('Cloud non disponibile');
    return;
  }
  const fixed = document.getElementById('bacheca-fixed').checked;
  const { error } = await supabase.from('bacheca').insert({
    testo,
    created_by: currentOperator || 'Sconosciuto',
    fixed
  });
  if (error) {
    showToast('Errore: ' + error.message);
    console.error(error);
    return;
  }
  document.getElementById('bacheca-text').value = '';
  document.getElementById('bacheca-fixed').checked = false;
  document.getElementById('bacheca-form').classList.add('hidden');
  showToast('Messaggio pubblicato');
  await loadBacheca();
}

async function deleteBacheca(id) {
  if (!confirm('Eliminare questo messaggio?')) return;
  if (!supabase) return;
  const { error } = await supabase.from('bacheca').delete().eq('id', id);
  if (error) {
    showToast('Errore eliminazione: ' + error.message);
    return;
  }
  showToast('Messaggio eliminato');
  await loadBacheca();
}

// ========== TASKS ==========
async function loadTasks() {
  if (!supabase) return;
  try {
    const { data, error } = await supabase
      .from('tasks')
      .select('*')
      .order('priorita', { ascending: true })
      .order('created_at', { ascending: false });
    if (error) {
      console.error('tasks load:', error);
      return;
    }
    tasksList = data || [];
    renderTasks();
    updateMyTasksAlert();
  } catch (e) {
    console.error(e);
  }
}

function getMyOpenTasks() {
  if (!currentOperator) return [];
  return tasksList.filter(t =>
    t.stato !== 'fatto' &&
    Array.isArray(t.responsabili) &&
    t.responsabili.includes(currentOperator)
  );
}

function updateMyTasksAlert() {
  const el = document.getElementById('my-tasks-alert');
  if (!el) return;
  const mine = getMyOpenTasks();
  if (mine.length === 0) {
    el.classList.add('hidden');
    return;
  }
  const alte = mine.filter(t => t.priorita === 'alta').length;
  el.classList.remove('hidden');
  el.innerHTML = `Hai <strong>${mine.length}</strong> task da fare` +
    (alte ? ` (di cui <strong>${alte}</strong> ad alta priorità)` : '') +
    ` — tocca per aprirle`;
  el.onclick = () => {
    taskFilter = 'miei';
    document.querySelectorAll('.task-filter-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.filter === 'miei');
    });
    showPage('tasks');
    renderTasks();
  };
}

function notifyTasksOnLogin() {
  const mine = getMyOpenTasks();
  if (mine.length > 0) {
    const alte = mine.filter(t => t.priorita === 'alta').length;
    let msg = `Hai ${mine.length} task da completare`;
    if (alte) msg += ` (${alte} ad alta priorità)`;
    showToast(msg, 4000);
  }
}

function renderTasks() {
  const el = document.getElementById('tasks-list');
  if (!el) return;

  let list = [...tasksList];
  if (taskFilter === 'miei') {
    list = list.filter(t =>
      t.stato !== 'fatto' &&
      Array.isArray(t.responsabili) &&
      t.responsabili.includes(currentOperator)
    );
  } else if (taskFilter === 'aperti') {
    list = list.filter(t => t.stato !== 'fatto');
  } else if (taskFilter === 'fatti') {
    list = list.filter(t => t.stato === 'fatto');
  }

  // Sort: alta first, then by date
  list.sort((a, b) => {
    if (a.stato === 'fatto' && b.stato !== 'fatto') return 1;
    if (b.stato === 'fatto' && a.stato !== 'fatto') return -1;
    if (a.priorita === 'alta' && b.priorita !== 'alta') return -1;
    if (b.priorita === 'alta' && a.priorita !== 'alta') return 1;
    return new Date(b.created_at || 0) - new Date(a.created_at || 0);
  });

  if (!list.length) {
    el.innerHTML = '<p class="muted-center">Nessun task in questa vista</p>';
    return;
  }

  el.innerHTML = list.map(t => {
    const resp = (t.responsabili || []).join(', ');
    const date = t.created_at ? new Date(t.created_at).toLocaleDateString('it-IT') : '';
    const isDone = t.stato === 'fatto';
    const cls = (t.priorita === 'alta' ? 'alta ' : '') + (isDone ? 'fatto' : '');
    return `<div class="task-card ${cls}" data-id="${t.id}">
      <div class="task-card-title">${escapeHtml(t.titolo)}</div>
      ${t.descrizione ? `<div class="task-card-desc">${escapeHtml(t.descrizione)}</div>` : ''}
      <div class="task-card-meta">
        <span class="task-badge ${t.priorita}">${t.priorita === 'alta' ? 'Alta priorità' : 'Normale'}</span>
        ${isDone ? '<span class="task-badge fatto">Completato</span>' : ''}
        <span>${escapeHtml(resp)}</span>
        <span>${date}</span>
        ${t.created_by ? `<span>da ${escapeHtml(t.created_by)}</span>` : ''}
      </div>
      ${!isDone ? `<div class="task-actions">
        <button class="btn btn-primary btn-complete-task" data-id="${t.id}">✓ Completa</button>
        <button class="btn btn-secondary btn-delete-task" data-id="${t.id}">Elimina</button>
      </div>` : `<div class="task-actions">
        <button class="btn btn-secondary btn-delete-task" data-id="${t.id}">Elimina</button>
      </div>`}
    </div>`;
  }).join('');

  el.querySelectorAll('.btn-complete-task').forEach(btn => {
    btn.onclick = () => completeTask(btn.dataset.id);
  });
  el.querySelectorAll('.btn-delete-task').forEach(btn => {
    btn.onclick = () => deleteTask(btn.dataset.id);
  });
}

function openTaskForm() {
  editingTaskId = null;
  document.getElementById('task-form-title').textContent = 'Nuovo task';
  document.getElementById('task-titolo').value = '';
  document.getElementById('task-descrizione').value = '';
  document.getElementById('task-priorita').value = 'normale';
  document.querySelectorAll('#task-responsabili input').forEach(cb => { cb.checked = false; });
  // Pre-check current operator
  document.querySelectorAll('#task-responsabili input').forEach(cb => {
    if (cb.value === currentOperator) cb.checked = true;
  });
  document.getElementById('task-form-overlay').classList.remove('hidden');
}

function closeTaskForm() {
  document.getElementById('task-form-overlay').classList.add('hidden');
  editingTaskId = null;
}

async function saveTask() {
  const titolo = (document.getElementById('task-titolo').value || '').trim();
  const descrizione = (document.getElementById('task-descrizione').value || '').trim();
  const priorita = document.getElementById('task-priorita').value;
  const responsabili = [...document.querySelectorAll('#task-responsabili input:checked')].map(cb => cb.value);

  if (!titolo) {
    showToast('Inserisci il titolo');
    return;
  }
  if (!responsabili.length) {
    showToast('Seleziona almeno un responsabile');
    return;
  }
  if (!supabase) {
    showToast('Cloud non disponibile');
    return;
  }

  const payload = {
    titolo,
    descrizione: descrizione || null,
    priorita,
    responsabili,
    stato: 'da_fare',
    created_by: currentOperator || 'Sconosciuto'
  };

  const { error } = await supabase.from('tasks').insert(payload);
  if (error) {
    showToast('Errore: ' + error.message);
    console.error(error);
    return;
  }
  showToast('Task creato');
  closeTaskForm();
  await loadTasks();
}

async function completeTask(id) {
  if (!supabase) return;
  const { error } = await supabase.from('tasks').update({
    stato: 'fatto',
    completed_at: new Date().toISOString(),
    completed_by: currentOperator || 'Sconosciuto'
  }).eq('id', id);
  if (error) {
    showToast('Errore: ' + error.message);
    return;
  }
  showToast('Task completato!');
  await loadTasks();
}

async function deleteTask(id) {
  if (!confirm('Eliminare questo task?')) return;
  if (!supabase) return;
  const { error } = await supabase.from('tasks').delete().eq('id', id);
  if (error) {
    showToast('Errore: ' + error.message);
    return;
  }
  showToast('Task eliminato');
  await loadTasks();
}



// ========== TURNI (foto settimanale + storico) ==========
const GIORNI_CORTI = ['dom','lun','mar','mer','gio','ven','sab'];
const MESI = ['gennaio','febbraio','marzo','aprile','maggio','giugno','luglio','agosto','settembre','ottobre','novembre','dicembre'];

function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return y + '-' + m + '-' + day;
}

function parseDate(str) {
  return new Date(str + 'T12:00:00');
}

function mondayOf(d) {
  const x = new Date(d);
  x.setHours(12,0,0,0);
  const day = x.getDay(); // 0=dom
  const diff = day === 0 ? -6 : 1 - day;
  x.setDate(x.getDate() + diff);
  return x;
}

function sundayOf(monday) {
  const x = new Date(monday);
  x.setDate(x.getDate() + 6);
  return x;
}

function formatRange(inizio, fine) {
  const a = parseDate(inizio);
  const b = parseDate(fine);
  const sameMonth = a.getMonth() === b.getMonth();
  if (sameMonth) {
    return a.getDate() + ' – ' + b.getDate() + ' ' + MESI[a.getMonth()] + ' ' + a.getFullYear();
  }
  return a.getDate() + ' ' + MESI[a.getMonth()].slice(0,3) + ' – ' + b.getDate() + ' ' + MESI[b.getMonth()].slice(0,3) + ' ' + b.getFullYear();
}

function isCurrentWeek(inizio, fine) {
  const today = toDateStr(new Date());
  return today >= inizio && today <= fine;
}

async function loadTurni() {
  if (!supabase) return;
  try {
    const { data, error } = await supabase
      .from('turni_settimane')
      .select('*')
      .order('settimana_inizio', { ascending: false });
    if (error) {
      console.error('turni load:', error);
      const el = document.getElementById('turni-list');
      if (el) el.innerHTML = '<p class="muted-center">Errore caricamento. Verifica la tabella turni_settimane su Supabase.</p>';
      return;
    }
    turniList = data || [];
    renderTurni();
    updateTurniDash();
  } catch (e) {
    console.error(e);
  }
}

function renderTurni() {
  const el = document.getElementById('turni-list');
  const corrente = document.getElementById('turni-corrente');
  if (!el) return;

  if (!turniList.length) {
    el.innerHTML = '<p class="muted-center">Nessuna settimana in archivio.<br>Carica la foto del foglio turni.</p>';
    if (corrente) corrente.classList.add('hidden');
    return;
  }

  // Current week at top if exists
  const current = turniList.find(t => isCurrentWeek(t.settimana_inizio, t.settimana_fine));
  if (corrente) {
    if (current) {
      corrente.classList.remove('hidden');
      corrente.innerHTML = `
        <div class="turni-corrente-label">Settimana in corso</div>
        <div class="turni-corrente-range">${formatRange(current.settimana_inizio, current.settimana_fine)}</div>
        ${current.image_url ? `<img class="turno-thumb" src="${current.image_url}" alt="Turni settimana" data-id="${current.id}">` : '<p class="muted-center">Nessuna foto</p>'}
        ${current.note ? `<div class="turno-note">${escapeHtml(current.note)}</div>` : ''}
        <div class="turno-meta">Caricato da ${escapeHtml(current.uploaded_by || '')}</div>
      `;
      const img = corrente.querySelector('.turno-thumb');
      if (img) img.onclick = () => openTurnoViewer(current);
    } else {
      corrente.classList.add('hidden');
    }
  }

  const past = turniList.filter(t => !isCurrentWeek(t.settimana_inizio, t.settimana_fine));
  if (!past.length) {
    el.innerHTML = '<p class="muted-center">Nessuna settimana precedente in archivio.</p>';
    return;
  }
  el.innerHTML = past.map(t => {
    return `<div class="turno-card" data-id="${t.id}">
      ${t.image_url ? `<img class="turno-thumb-sm" src="${t.image_url}" alt="Turni">` : ''}
      <div class="turno-card-body">
        <div class="turno-day">${formatRange(t.settimana_inizio, t.settimana_fine)}</div>
        <div class="turno-meta">
          <span>${escapeHtml(t.uploaded_by || '')}</span>
          <span>${t.created_at ? new Date(t.created_at).toLocaleDateString('it-IT') : ''}</span>
        </div>
        ${t.note ? `<div class="turno-note">${escapeHtml(t.note)}</div>` : ''}
        <button type="button" class="btn-text-back btn-del-settimana" data-id="${t.id}">Elimina</button>
      </div>
    </div>`;
  }).join('');

  el.querySelectorAll('.turno-card').forEach(card => {
    card.onclick = () => {
      const t = turniList.find(x => String(x.id) === String(card.dataset.id));
      if (t) openTurnoViewer(t);
    };
  });
  el.querySelectorAll('.btn-del-settimana').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      deleteSettimana(btn.dataset.id);
    };
  });
}

function updateTurniDash() {
  // Banner turni rimosso dalla Home (si usano dal menu)
  const el = document.getElementById('turni-dash');
  if (el) el.classList.add('hidden');
}

// Zoom/pan state for turno viewer
let viewerScale = 1;
let viewerX = 0;
let viewerY = 0;
let viewerPointers = new Map();
let viewerLastDist = 0;
let viewerPanning = false;

function applyViewerTransform() {
  const img = document.getElementById('turno-viewer-img');
  if (!img) return;
  img.style.transform = `translate(${viewerX}px, ${viewerY}px) scale(${viewerScale})`;
}

function resetViewerZoom() {
  viewerScale = 1;
  viewerX = 0;
  viewerY = 0;
  applyViewerTransform();
}

function zoomViewer(delta) {
  const prev = viewerScale;
  viewerScale = Math.min(5, Math.max(1, viewerScale + delta));
  if (viewerScale === 1) {
    viewerX = 0;
    viewerY = 0;
  }
  applyViewerTransform();
}

function openTurnoViewer(t) {
  if (!t || !t.image_url) {
    showToast('Nessuna foto per questa settimana');
    return;
  }
  const img = document.getElementById('turno-viewer-img');
  img.src = t.image_url;
  document.getElementById('turno-viewer-caption').textContent = formatRange(t.settimana_inizio, t.settimana_fine) +
    (t.uploaded_by ? ' · ' + t.uploaded_by : '');
  resetViewerZoom();
  document.getElementById('turno-viewer').classList.remove('hidden');
  // Prevent body scroll while viewing
  document.body.style.overflow = 'hidden';
}

function closeTurnoViewer() {
  document.getElementById('turno-viewer').classList.add('hidden');
  document.getElementById('turno-viewer-img').src = '';
  resetViewerZoom();
  document.body.style.overflow = '';
}

function initViewerGestures() {
  const stage = document.getElementById('turno-viewer-stage');
  const img = document.getElementById('turno-viewer-img');
  if (!stage || !img || stage.dataset.gestures === '1') return;
  stage.dataset.gestures = '1';

  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    viewerPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (viewerPointers.size === 2) {
      const pts = [...viewerPointers.values()];
      viewerLastDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    } else if (viewerPointers.size === 1 && viewerScale > 1) {
      viewerPanning = true;
    }
  });

  stage.addEventListener('pointermove', (e) => {
    if (!viewerPointers.has(e.pointerId)) return;
    const prev = viewerPointers.get(e.pointerId);
    viewerPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (viewerPointers.size === 2) {
      const pts = [...viewerPointers.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (viewerLastDist > 0) {
        const ratio = dist / viewerLastDist;
        viewerScale = Math.min(5, Math.max(1, viewerScale * ratio));
        if (viewerScale === 1) { viewerX = 0; viewerY = 0; }
        applyViewerTransform();
      }
      viewerLastDist = dist;
    } else if (viewerPanning && viewerPointers.size === 1 && viewerScale > 1) {
      viewerX += e.clientX - prev.x;
      viewerY += e.clientY - prev.y;
      applyViewerTransform();
    }
  });

  const endPtr = (e) => {
    viewerPointers.delete(e.pointerId);
    if (viewerPointers.size < 2) viewerLastDist = 0;
    if (viewerPointers.size === 0) viewerPanning = false;
  };
  stage.addEventListener('pointerup', endPtr);
  stage.addEventListener('pointercancel', endPtr);

  // Double-tap to toggle zoom
  let lastTap = 0;
  stage.addEventListener('click', (e) => {
    const now = Date.now();
    if (now - lastTap < 300) {
      if (viewerScale > 1.2) {
        resetViewerZoom();
      } else {
        viewerScale = 2.5;
        applyViewerTransform();
      }
    }
    lastTap = now;
  });
}


function openNewSettimanaForm() {
  const mon = mondayOf(new Date());
  const sun = sundayOf(mon);
  document.getElementById('turno-inizio').value = toDateStr(mon);
  document.getElementById('turno-fine').value = toDateStr(sun);
  document.getElementById('turno-note').value = '';
  document.getElementById('turno-foto').value = '';
  document.getElementById('turno-foto-preview').classList.add('hidden');
  document.getElementById('turno-foto-preview').innerHTML = '';
  document.getElementById('turno-upload-msg').classList.add('hidden');
  document.getElementById('turno-form-overlay').classList.remove('hidden');
}

function closeTurnoForm() {
  document.getElementById('turno-form-overlay').classList.add('hidden');
}

// Auto-fill fine when inizio changes ( +6 days)
function onInizioChange() {
  const v = document.getElementById('turno-inizio').value;
  if (!v) return;
  const mon = parseDate(v);
  // snap to monday of that week? keep user choice but set fine = +6
  const sun = new Date(mon);
  sun.setDate(sun.getDate() + 6);
  document.getElementById('turno-fine').value = toDateStr(sun);
}

async function saveTurno() {
  const inizio = document.getElementById('turno-inizio').value;
  let fine = document.getElementById('turno-fine').value;
  const note = (document.getElementById('turno-note').value || '').trim() || null;
  const fileInput = document.getElementById('turno-foto');
  const msg = document.getElementById('turno-upload-msg');

  if (!inizio) {
    showToast('Seleziona l\'inizio settimana');
    return;
  }
  if (!fine) {
    const sun = parseDate(inizio);
    sun.setDate(sun.getDate() + 6);
    fine = toDateStr(sun);
  }
  if (!fileInput.files || !fileInput.files[0]) {
    showToast('Seleziona la foto del foglio turni');
    return;
  }
  if (!supabase) {
    showToast('Cloud non disponibile');
    return;
  }

  const file = fileInput.files[0];
  msg.classList.remove('hidden');
  msg.className = 'msg';
  msg.textContent = 'Caricamento foto in corso...';

  try {
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
    const path = `settimane/${inizio}_${Date.now()}.${ext}`;

    const { error: upErr } = await supabase.storage
      .from('turni')
      .upload(path, file, { contentType: file.type || 'image/jpeg', upsert: false });

    if (upErr) {
      console.error(upErr);
      msg.className = 'msg error';
      msg.textContent = 'Errore upload: ' + upErr.message + ' (verifica bucket "turni" su Supabase Storage)';
      return;
    }

    const { data: urlData } = supabase.storage.from('turni').getPublicUrl(path);
    const image_url = urlData.publicUrl;

    const { error } = await supabase.from('turni_settimane').insert({
      settimana_inizio: inizio,
      settimana_fine: fine,
      image_url,
      image_path: path,
      note,
      uploaded_by: currentOperator || 'Sconosciuto'
    });

    if (error) {
      msg.className = 'msg error';
      msg.textContent = 'Errore salvataggio: ' + error.message;
      return;
    }

    msg.className = 'msg success';
    msg.textContent = 'Settimana salvata in archivio!';
    showToast('Foglio turni archiviato');
    closeTurnoForm();
    await loadTurni();
  } catch (err) {
    console.error(err);
    msg.className = 'msg error';
    msg.textContent = 'Errore: ' + err.message;
  }
}

async function deleteSettimana(id) {
  if (!confirm('Eliminare questa settimana dall\'archivio?')) return;
  if (!supabase) return;
  const t = turniList.find(x => x.id === id);
  // delete from storage if path known
  if (t && t.image_path) {
    try {
      await supabase.storage.from('turni').remove([t.image_path]);
    } catch (e) {}
  }
  const { error } = await supabase.from('turni_settimane').delete().eq('id', id);
  if (error) {
    showToast('Errore: ' + error.message);
    return;
  }
  showToast('Eliminata dall\'archivio');
  await loadTurni();
}


// ========== THEME ==========
function getTheme() {
  return localStorage.getItem('petstore_theme') || 'light';
}

function applyTheme(theme) {
  const t = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('petstore_theme', t);
  const btnL = document.getElementById('btn-theme-light');
  const btnD = document.getElementById('btn-theme-dark');
  if (btnL) btnL.classList.toggle('active', t === 'light');
  if (btnD) btnD.classList.toggle('active', t === 'dark');
}

function initTheme() {
  applyTheme(getTheme());
}


// ========== MISSIONE GIORNALIERA ==========
function todayStr() {
  return toDateStr(new Date());
}

function isAfterMissionHour() {
  return new Date().getHours() >= MISSIONE_HOUR;
}

function countProdottiSenzaData() {
  // Prodotti in negozio, non accessori, ancora senza data di scadenza
  return products.filter(p =>
    p.ean &&
    !nonInNegozio.has(p.ean) &&
    !p.noExpiry &&
    !p.expiry
  ).length;
}

function pickRandomProducts(n, excludeEans) {
  // Obiettivo 3-4 mesi: solo prodotti SENZA data di scadenza da inserire
  // Esclude: non in negozio + accessori / senza scadenza (noExpiry) + già assegnati oggi
  const exclude = excludeEans instanceof Set ? excludeEans : new Set(excludeEans || []);
  const pool = products.filter(p =>
    p.ean &&
    !nonInNegozio.has(p.ean) &&
    !p.noExpiry &&
    !p.expiry &&
    !exclude.has(p.ean)
  );
  const arr = [...pool];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, Math.min(n, arr.length)).map(p => p.ean);
}

async function ensureMissioneOggi() {
  if (!supabase) {
    console.warn('missione: supabase null');
    return null;
  }
  if (!products.length) {
    console.warn('missione: catalogo vuoto');
    return null;
  }
  if (!currentOperator) {
    console.warn('missione: nessun operatore');
    return null;
  }
  if (!isAfterMissionHour()) {
    missioneOggi = null;
    return null;
  }
  const data = todayStr();
  const op = currentOperator;
  try {
    // 1) Cerca missione personale di oggi
    let row = null;
    let { data: rows, error } = await supabase
      .from('missioni')
      .select('*')
      .eq('data', data)
      .eq('operator', op)
      .limit(1);
    if (error) {
      console.error('missione load:', error);
      const msg = (error.message || '').toLowerCase();
      if (msg.includes('operator') || msg.includes('column')) {
        showToast('SQL: aggiungi colonna operator alla tabella missioni');
      } else {
        showToast('Errore missione: ' + error.message);
      }
      return null;
    }
    row = (rows && rows[0]) || null;

    if (!row) {
      // 2) Prodotti già assegnati oggi ad altri operatori
      let assigned = new Set();
      try {
        const { data: others } = await supabase
          .from('missioni')
          .select('prodotti, operator')
          .eq('data', data);
        (others || []).forEach(m => {
          const list = Array.isArray(m.prodotti) ? m.prodotti : [];
          list.forEach(e => assigned.add(e));
        });
      } catch (e) {}

      let eans = pickRandomProducts(MISSIONE_COUNT, assigned);
      // Se il pool escluso è troppo stretto, riprova senza esclusioni
      if (!eans.length) {
        eans = pickRandomProducts(MISSIONE_COUNT, new Set());
      }
      if (!eans.length) {
        console.warn('missione: nessun prodotto senza data disponibile');
        missioneOggi = null;
        return null;
      }

      // 3) Rimuovi missioni legacy di oggi senza operatore (bloccano unique su data)
      try {
        await supabase.from('missioni').delete().eq('data', data).is('operator', null);
      } catch (e) {}

      // 4) Inserisci missione personale
      let { data: created, error: insErr } = await supabase
        .from('missioni')
        .insert({
          data,
          operator: op,
          prodotti: eans,
          created_by: op
        })
        .select()
        .limit(1);
      if (insErr) {
        console.error('missione insert:', insErr);
        // Possibile unique(data) ancora attivo: aggiorna la riga del giorno
        const { data: existing } = await supabase
          .from('missioni')
          .select('*')
          .eq('data', data)
          .limit(5);
        const mine = (existing || []).find(r => r.operator === op);
        if (mine) {
          row = mine;
        } else if (existing && existing.length === 1 && !existing[0].operator) {
          const { data: updated, error: upErr } = await supabase
            .from('missioni')
            .update({ operator: op, prodotti: eans, created_by: op })
            .eq('data', data)
            .select()
            .limit(1);
          if (upErr) {
            showToast('Errore salvataggio missione: ' + upErr.message);
            return null;
          }
          row = updated && updated[0];
        } else if (existing && existing.length >= 1) {
          // Unique solo su data: crea lista personale in locale per non bloccare il negozio
          row = {
            data,
            operator: op,
            prodotti: eans,
            created_by: op,
            _localOnly: true
          };
          showToast('Missione locale (esegui SQL unique data+operator)');
        } else {
          showToast('Errore creazione missione: ' + insErr.message);
          return null;
        }
      } else {
        row = (created && created[0]) || null;
      }
    }

    // Normalizza prodotti (array)
    if (row && row.prodotti && !Array.isArray(row.prodotti)) {
      try {
        row.prodotti = typeof row.prodotti === 'string' ? JSON.parse(row.prodotti) : [];
      } catch (e) {
        row.prodotti = [];
      }
    }

    missioneOggi = row;
    await loadMissioneProgress();
    return row;
  } catch (e) {
    console.error('ensureMissioneOggi', e);
    showToast('Errore missione: ' + (e.message || e));
    return null;
  }
}

async function loadMissioneProgress() {
  if (!supabase || !missioneOggi || !currentOperator) return;
  const data = missioneOggi.data;
  const op = currentOperator;
  // Progresso e completamento solo per QUESTO operatore
  const [prog, comp] = await Promise.all([
    supabase.from('missioni_progress').select('*').eq('data', data).eq('operator', op),
    supabase.from('missioni_completate').select('*').eq('data', data)
  ]);
  missioneProgress = prog.data || [];
  missioneCompletate = comp.data || [];
}

function myCheckedEans() {
  if (!currentOperator) return new Set();
  return new Set(
    missioneProgress
      .filter(p => p.operator === currentOperator)
      .map(p => p.ean)
  );
}

function isProductCheckedByMe(ean) {
  return myCheckedEans().has(ean);
}

function myMissionDone() {
  if (!missioneOggi || !currentOperator) return false;
  return missioneCompletate.some(c => c.operator === currentOperator);
}

function myMissionProgress() {
  if (!missioneOggi || !missioneOggi.prodotti) return { done: 0, total: 0 };
  const total = missioneOggi.prodotti.length;
  const done = missioneOggi.prodotti.filter(ean => isProductCheckedByMe(ean)).length;
  return { done, total };
}

async function markProductChecked(ean) {
  if (!supabase || !missioneOggi || !currentOperator) return;
  const { error } = await supabase.from('missioni_progress').upsert({
    data: missioneOggi.data,
    ean,
    operator: currentOperator,
    checked_at: new Date().toISOString()
  }, { onConflict: 'data,ean,operator' });
  if (error) {
    showToast('Errore: ' + error.message);
    return;
  }
  await loadMissioneProgress();
  // Auto-complete mission if all checked
  const { done, total } = myMissionProgress();
  if (done >= total && total > 0 && !myMissionDone()) {
    await supabase.from('missioni_completate').upsert({
      data: missioneOggi.data,
      operator: currentOperator,
      completed_at: new Date().toISOString()
    }, { onConflict: 'data,operator' });
    await loadMissioneProgress();
    showToast('Missione completata');
  } else {
    showToast('Prodotto controllato ✓');
  }
  renderMissione();
  updateMissioneDash();
}

function renderMissione() {
  const statusEl = document.getElementById('missione-status');
  const listEl = document.getElementById('missione-list');
  const opsEl = document.getElementById('missione-operators');
  if (!statusEl || !listEl) return;

  if (!isAfterMissionHour()) {
    statusEl.innerHTML = `<div class="mission-title">Missione non ancora attiva</div>
      <p class="mission-progress">Si genera alle ${MISSIONE_HOUR}:00.</p>`;
    listEl.innerHTML = '';
    if (opsEl) opsEl.innerHTML = '';
    return;
  }

  if (!missioneOggi || !missioneOggi.prodotti || !missioneOggi.prodotti.length) {
    const restanti = countProdottiSenzaData();
    statusEl.innerHTML = `<div class="mission-title">Nessuna missione</div>
      <p class="mission-progress">${restanti === 0
        ? 'Tutti i prodotti in negozio hanno già la data di scadenza. Ottimo lavoro!'
        : 'Impossibile creare la missione. Controlla Supabase (colonna <strong>operator</strong> + indice unico su data+operator) oppure tocca Sincronizza.<br><br>Prodotti ancora senza data: <strong>' + restanti + '</strong>'}</p>
      <button type="button" class="btn btn-primary" id="btn-retry-missione" style="margin-top:12px;">Riprova a generare</button>`;
    listEl.innerHTML = '';
    const btn = document.getElementById('btn-retry-missione');
    if (btn) btn.onclick = () => refreshMissione();
    return;
  }

  const { done, total } = myMissionProgress();
  const pct = total ? Math.round((done / total) * 100) : 0;
  const completed = myMissionDone();
  const restanti = countProdottiSenzaData();

  statusEl.innerHTML = `
    <div class="mission-hero ${completed ? 'done' : ''}">
      <div class="mission-count">${done}/${total}</div>
      <div class="missione-progress-bar"><span style="width:${pct}%"></span></div>
      <p class="mission-progress">${completed ? 'Missione completata' : 'Da controllare oggi'}</p>
    </div>
  `;

  // Stato completamento missioni personali degli altri
  if (opsEl) {
    opsEl.innerHTML = OPERATORS.map(op => {
      const doneOp = missioneCompletate.some(c => c.operator === op);
      const mine = op === currentOperator;
      return `<span class="missione-op-chip ${doneOp ? 'done' : ''} ${mine ? 'mine' : ''}">${op}${mine ? ' · tu' : ''}${doneOp ? ' · fatto' : ''}</span>`;
    }).join('');
  }

  const todo = [];
  const doneEans = [];
  (missioneOggi.prodotti || []).forEach(ean => {
    if (isProductCheckedByMe(ean)) doneEans.push(ean);
    else todo.push(ean);
  });

  function missionCard(ean, checked) {
    const p = products.find(x => x.ean === ean);
    if (!p) {
      return `<div class="product-card" data-ean="${ean}"><div class="product-name">EAN ${ean}</div></div>`;
    }
    const days = p.noExpiry ? null : daysRemaining(p.expiry);
    const cls = p.noExpiry ? 'ok' : getStatusClass(days);
    const supplier = p.supplier ? escapeHtml(p.supplier) : '';
    return `<div class="product-card ${cls} ${checked ? 'mission-checked' : ''}" data-ean="${ean}">
      <div class="product-card-top">
        <div class="product-name">${escapeHtml(p.name)}</div>
        ${getBadge(days, p.signaled, p.noExpiry)}
      </div>
      <div class="product-meta">
        ${supplier ? `<span class="product-supplier">${supplier}</span>` : ''}
        <span class="product-ean">${escapeHtml(ean)}</span>
      </div>
      ${checked
        ? `<button class="btn btn-secondary mission-check-btn" disabled>Fatto</button>`
        : `<button class="btn btn-primary mission-check-btn btn-check-mission" data-ean="${ean}">Segna controllato</button>`
      }
    </div>`;
  }

  listEl.innerHTML =
    (todo.length ? todo.map(ean => missionCard(ean, false)).join('') : (completed ? '<p class="muted-center">Niente da fare: missione completa.</p>' : '')) +
    (doneEans.length ? `<details class="mission-done-fold"><summary>Già fatti (${doneEans.length})</summary>${doneEans.map(ean => missionCard(ean, true)).join('')}</details>` : '');

  listEl.querySelectorAll('.product-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.btn-check-mission')) return;
      openProduct(card.dataset.ean, 'missione');
    });
  });
  listEl.querySelectorAll('.btn-check-mission').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      markProductChecked(btn.dataset.ean);
    };
  });
}

function updateMissioneDash() {
  const el = document.getElementById('missione-dash');
  if (!el) return;

  if (!isAfterMissionHour()) {
    el.classList.remove('hidden', 'done');
    el.innerHTML = `Missione dalle ${MISSIONE_HOUR}:00`;
    el.onclick = () => showPage('missione');
    return;
  }

  if (!missioneOggi || !missioneOggi.prodotti) {
    el.classList.add('hidden');
    return;
  }

  const { done, total } = myMissionProgress();
  const completed = myMissionDone();
  el.classList.remove('hidden');
  if (completed) {
    el.classList.add('done');
    el.innerHTML = `Missione di oggi completata (${total}/${total})`;
  } else {
    el.classList.remove('done');
    el.innerHTML = `Missione di oggi: <strong>${done}/${total}</strong> — tocca per aprire`;
  }
  el.onclick = () => { showPage('missione'); renderMissione(); };
}

async function refreshMissione() {
  await ensureMissioneOggi();
  renderMissione();
  updateMissioneDash();
}



// ========== NON IN NEGOZIO ==========
async function loadNonInNegozio() {
  if (!supabase) return;
  try {
    const { data, error } = await supabase.from('prodotti_non_in_negozio').select('ean');
    if (error) {
      console.error('non in negozio:', error);
      return;
    }
    nonInNegozio = new Set((data || []).map(r => r.ean));
  } catch (e) {
    console.error(e);
  }
}

async function toggleNonInNegozio(ean) {
  if (!supabase || !ean) return;
  const isOut = nonInNegozio.has(ean);
  if (isOut) {
    const { error } = await supabase.from('prodotti_non_in_negozio').delete().eq('ean', ean);
    if (error) {
      showToast('Errore: ' + error.message);
      return;
    }
    nonInNegozio.delete(ean);
    showToast('Prodotto segnato come in negozio');
  } else {
    const { error } = await supabase.from('prodotti_non_in_negozio').upsert({
      ean,
      updated_by: currentOperator || 'Sconosciuto',
      updated_at: new Date().toISOString()
    }, { onConflict: 'ean' });
    if (error) {
      showToast('Errore: ' + error.message);
      return;
    }
    nonInNegozio.add(ean);
    showToast('Prodotto segnato come non in negozio');
  }
  // refresh detail button if still on same product
  if (currentProduct && currentProduct.ean === ean) {
    openProduct(ean, detailReturnPage);
  }
  renderNonInNegozio();
}

function renderNonInNegozio() {
  const el = document.getElementById('non-negozio-list');
  if (!el) return;
  const list = products.filter(p => nonInNegozio.has(p.ean));
  if (!list.length) {
    el.innerHTML = '<p class="muted-center">Nessun prodotto segnato come non in negozio.<br>Apri un prodotto e usa il pulsante «Segna come non in negozio».</p>';
    return;
  }
  list.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'it'));
  el.innerHTML = list.map(p => {
    const days = daysRemaining(p.expiry);
    const cls = getStatusClass(days);
    return `<div class="product-card ${cls}" data-ean="${p.ean}">
      <div class="product-name">${escapeHtml(p.name)}</div>
      <div class="product-meta">
        <span>${p.ean}</span>
        ${getBadge(days, p.signaled, p.noExpiry)}
        ${p.supplier ? `<span>${escapeHtml((p.supplier||'').split(' ')[0])}</span>` : ''}
      </div>
    </div>`;
  }).join('');
  el.querySelectorAll('.product-card').forEach(card => {
    card.onclick = () => openProduct(card.dataset.ean, 'non-negozio');
  });
}



// ========== CONSEGNE ==========
function normalizeConsegnaDate(d) {
  if (!d) return '';
  if (typeof d === 'string') return d.slice(0, 10);
  try {
    return toDateStr(new Date(d));
  } catch (e) {
    return String(d).slice(0, 10);
  }
}

function normalizeConsegnaRow(row) {
  if (!row) return row;
  return {
    ...row,
    data: normalizeConsegnaDate(row.data),
    ora: row.ora ? String(row.ora).slice(0, 5) : null,
    stato: row.stato === 'consegnato' ? 'consegnato' : 'prevista'
  };
}

function setConsegneFilter(filter) {
  consegneFilter = filter || 'prossime';
  document.querySelectorAll('#consegne-filters .task-filter-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.cfilter === consegneFilter);
  });
}

async function loadConsegne() {
  if (!supabase) return;
  try {
    const { data, error } = await supabase
      .from('consegne')
      .select('*')
      .order('data', { ascending: true });
    if (error) {
      console.error('consegne:', error);
      showToast('Errore caricamento consegne: ' + error.message);
      return;
    }
    consegneList = (data || []).map(normalizeConsegnaRow);
    renderConsegne();
    updateConsegneDash();
  } catch (e) {
    console.error(e);
  }
}

function populateConsegnaFornitore() {
  const sel = document.getElementById('consegna-fornitore');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">— Seleziona fornitore —</option>';
  (typeof SUPPLIERS_LIST !== 'undefined' ? SUPPLIERS_LIST : []).forEach(s => {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s;
    sel.appendChild(opt);
  });
  if (current) sel.value = current;
}

function renderConsegne() {
  const el = document.getElementById('consegne-list');
  if (!el) return;
  const oggi = todayStr();
  let list = [...consegneList];

  if (consegneFilter === 'oggi') {
    list = list.filter(c => normalizeConsegnaDate(c.data) === oggi);
  } else if (consegneFilter === 'prossime') {
    // future + today, not yet delivered
    list = list.filter(c => {
      const d = normalizeConsegnaDate(c.data);
      return d >= oggi && c.stato !== 'consegnato';
    });
  } else if (consegneFilter === 'storico') {
    // past dates OR already delivered (history kept)
    list = list.filter(c => {
      const d = normalizeConsegnaDate(c.data);
      return d < oggi || c.stato === 'consegnato';
    });
  }
  // 'tutte' = no filter

  list.sort((a, b) => {
    const da = normalizeConsegnaDate(a.data);
    const db = normalizeConsegnaDate(b.data);
    // storico: newest first; others: oldest first
    if (consegneFilter === 'storico') {
      if (da !== db) return db.localeCompare(da);
    } else {
      if (da !== db) return da.localeCompare(db);
    }
    return (a.ora || '').localeCompare(b.ora || '');
  });

  if (!list.length) {
    const emptyMsg = {
      prossime: 'Nessuna consegna prevista in arrivo',
      oggi: 'Nessuna consegna per oggi',
      storico: 'Nessuna consegna nello storico',
      tutte: 'Nessuna consegna registrata'
    };
    el.innerHTML = '<p class="muted-center">' + (emptyMsg[consegneFilter] || 'Nessuna consegna') + '</p>';
    return;
  }

  el.innerHTML = list.map(c => {
    const dNorm = normalizeConsegnaDate(c.data);
    const isOggi = dNorm === oggi;
    const stato = c.stato === 'consegnato' ? 'consegnato' : 'prevista';
    const d = dNorm ? formatGiornoSafe(dNorm) : '';
    const statoLabel = stato === 'consegnato' ? 'Consegnato' : (isOggi ? 'Oggi' : 'In arrivo');
    const statoClass = stato === 'consegnato' ? 'consegnato' : (isOggi ? 'oggi' : 'prevista');
    return `<div class="consegna-card ${isOggi ? 'oggi' : ''} ${stato}" data-id="${c.id}">
      <div class="product-card-top">
        <div class="consegna-fornitore">${escapeHtml(c.fornitore || '')}</div>
        <span class="consegna-badge ${statoClass}">${statoLabel}</span>
      </div>
      <div class="consegna-meta">
        <span>${d}</span>
        ${c.ora ? '<span>' + escapeHtml(String(c.ora).slice(0,5)) + '</span>' : ''}
        ${c.created_by ? '<span>' + escapeHtml(c.created_by) + '</span>' : ''}
      </div>
      ${c.note ? '<div class="turno-note">' + escapeHtml(c.note) + '</div>' : ''}
    </div>`;
  }).join('');

  el.querySelectorAll('.consegna-card').forEach(card => {
    card.onclick = () => openConsegnaForm(card.dataset.id);
  });
}

function formatGiornoSafe(dateStr) {
  const norm = normalizeConsegnaDate(dateStr);
  try {
    if (typeof formatGiorno === 'function') return formatGiorno(norm);
  } catch (e) {}
  const d = new Date(norm + 'T12:00:00');
  return d.toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' });
}

function updateConsegneDash() {
  const el = document.getElementById('consegne-dash');
  if (!el) return;
  const oggi = todayStr();
  const oggiList = consegneList.filter(c => normalizeConsegnaDate(c.data) === oggi);
  if (!oggiList.length) {
    el.classList.add('hidden');
    return;
  }
  const pending = oggiList.filter(c => c.stato !== 'consegnato');
  const done = oggiList.filter(c => c.stato === 'consegnato');
  el.classList.remove('hidden');
  if (pending.length) {
    const names = pending.map(c => c.fornitore).join(', ');
    el.innerHTML = 'Oggi in arrivo: <strong>' + escapeHtml(names) + '</strong>' +
      (done.length ? ' · ' + done.length + ' già consegnat' + (done.length === 1 ? 'a' : 'e') : '');
  } else {
    el.innerHTML = 'Consegne di oggi: tutte segnate come consegnate';
  }
  el.onclick = () => {
    setConsegneFilter('oggi');
    showPage('consegne');
    renderConsegne();
  };
}

function openConsegnaForm(id) {
  editingConsegnaId = id || null;
  populateConsegnaFornitore();
  const title = document.getElementById('consegna-form-title');
  const btnDel = document.getElementById('btn-delete-consegna');
  if (id) {
    const c = consegneList.find(x => String(x.id) === String(id));
    if (!c) return;
    title.textContent = 'Modifica consegna';
    document.getElementById('consegna-data').value = normalizeConsegnaDate(c.data) || '';
    document.getElementById('consegna-fornitore').value = c.fornitore || '';
    document.getElementById('consegna-ora').value = (c.ora || '').toString().slice(0, 5);
    document.getElementById('consegna-note').value = c.note || '';
    document.getElementById('consegna-stato').value = c.stato === 'consegnato' ? 'consegnato' : 'prevista';
    if (btnDel) btnDel.classList.remove('hidden');
  } else {
    title.textContent = 'Nuova consegna';
    document.getElementById('consegna-data').value = todayStr();
    document.getElementById('consegna-fornitore').value = '';
    document.getElementById('consegna-ora').value = '';
    document.getElementById('consegna-note').value = '';
    document.getElementById('consegna-stato').value = 'prevista';
    if (btnDel) btnDel.classList.add('hidden');
  }
  document.getElementById('consegna-form-overlay').classList.remove('hidden');
}

function closeConsegnaForm() {
  document.getElementById('consegna-form-overlay').classList.add('hidden');
  editingConsegnaId = null;
}

async function saveConsegna() {
  const data = normalizeConsegnaDate(document.getElementById('consegna-data').value);
  const fornitore = document.getElementById('consegna-fornitore').value;
  const ora = document.getElementById('consegna-ora').value || null;
  const note = (document.getElementById('consegna-note').value || '').trim() || null;
  const stato = document.getElementById('consegna-stato').value || 'prevista';

  if (!data) {
    showToast('Seleziona la data');
    return;
  }
  if (!fornitore) {
    showToast('Seleziona il fornitore');
    return;
  }
  if (!supabase) {
    showToast('Cloud non disponibile');
    return;
  }

  const payload = {
    data,
    fornitore,
    ora,
    note,
    stato,
    updated_by: currentOperator || 'Sconosciuto',
    updated_at: new Date().toISOString()
  };

  let savedRow = null;
  let error = null;

  if (editingConsegnaId) {
    const res = await supabase
      .from('consegne')
      .update(payload)
      .eq('id', editingConsegnaId)
      .select()
      .maybeSingle();
    error = res.error;
    savedRow = res.data;
  } else {
    payload.created_by = currentOperator || 'Sconosciuto';
    const res = await supabase
      .from('consegne')
      .insert(payload)
      .select()
      .maybeSingle();
    error = res.error;
    savedRow = res.data;
  }

  if (error) {
    showToast('Errore: ' + error.message);
    console.error(error);
    return;
  }

  // Aggiornamento immediato in lista locale
  if (savedRow) {
    const row = normalizeConsegnaRow(savedRow);
    const idx = consegneList.findIndex(c => String(c.id) === String(row.id));
    if (idx >= 0) consegneList[idx] = row;
    else consegneList.push(row);
  }

  // Mostra la vista dove compare la consegna appena salvata
  const oggi = todayStr();
  if (stato === 'consegnato' || data < oggi) {
    setConsegneFilter('storico');
  } else if (data === oggi) {
    setConsegneFilter('oggi');
  } else {
    setConsegneFilter('prossime');
  }

  showToast(stato === 'consegnato' ? 'Consegna registrata ✓' : 'Consegna salvata');
  closeConsegnaForm();
  renderConsegne();
  updateConsegneDash();
  // Ricarica dal cloud per allineare tutti i campi
  await loadConsegne();
}

async function deleteConsegna() {
  if (!editingConsegnaId || !supabase) return;
  if (!confirm('Eliminare questa consegna?')) return;
  const { error } = await supabase.from('consegne').delete().eq('id', editingConsegnaId);
  if (error) {
    showToast('Errore: ' + error.message);
    return;
  }
  consegneList = consegneList.filter(c => String(c.id) !== String(editingConsegnaId));
  showToast('Consegna eliminata');
  closeConsegnaForm();
  renderConsegne();
  updateConsegneDash();
  await loadConsegne();
}


// ========== ORDINI FORNITORE (solo Santoemma) ==========
let ordineRows = [];
let ordineMeta = { fornitore: '', periodo: '' };

function isSantoemma() {
  return currentOperator === 'Santoemma';
}

function normalizeHeader(h) {
  return String(h || '')
    .toLowerCase()
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findCol(headers, candidates) {
  for (let i = 0; i < headers.length; i++) {
    const h = normalizeHeader(headers[i]);
    for (const c of candidates) {
      if (h.includes(c)) return i;
    }
  }
  return -1;
}

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && !isNaN(v)) return v;
  const s = String(v).replace(',', '.').replace(/[^\d.-]/g, '');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function calcOrdineConsigliato(venduti, giorni, giacenza, proiezione, pzCartone) {
  // Proiezione 30 gg se non presente
  let proj = proiezione;
  if (proj === null || proj === undefined) {
    if (venduti !== null && giorni && giorni > 0) proj = (venduti / giorni) * 30;
    else proj = venduti || 0;
  }
  const gia = giacenza === null || giacenza === undefined ? 0 : giacenza;
  let pezzi = Math.max(0, Math.ceil((proj || 0) - gia));
  // Se giacenza negativa, almeno coprire il buco + un minimo di rotazione
  if (gia < 0) pezzi = Math.max(pezzi, Math.ceil(Math.abs(gia) + (proj || 0) * 0.5));
  const pz = pzCartone && pzCartone > 1 ? pzCartone : 1;
  if (pz > 1) {
    // Ordine a cartoni: arrotonda per eccesso
    const cartoni = Math.ceil(pezzi / pz);
    return { pezzi: cartoni * pz, cartoni, unita: 'cartoni', pzCartone: pz };
  }
  return { pezzi, cartoni: pezzi, unita: 'pezzi', pzCartone: 1 };
}

function parseStatisticaSheet(workbook) {
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
  if (!rows.length) throw new Error('Foglio vuoto');

  // Cerca riga intestazione con "Prodotto"
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const r = rows[i] || [];
    const joined = r.map(normalizeHeader).join('|');
    if (joined.includes('prodotto') && (joined.includes('giacenza') || joined.includes('vendut'))) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) throw new Error('Intestazione non trovata (serve colonna Prodotto)');

  const headers = rows[headerIdx];
  const colProdotto = findCol(headers, ['prodotto']);
  const colCodice = findCol(headers, ['codice fornitore', 'codice', 'ean']);
  const colPz = findCol(headers, ['pz/cartone', 'pz cartone', 'pezzi/cartone', 'conf']);
  const colVenduti = findCol(headers, ['venduti']);
  const colMedia = findCol(headers, ['media']);
  const colProiezione = findCol(headers, ['proiezione']);
  const colGiacenza = findCol(headers, ['giacenza']);
  const colOrdine = findCol(headers, ['ordine']);
  const colPrio = findCol(headers, ['priorità', 'priorita']);
  const colNote = findCol(headers, ['note', 'categoria']);

  if (colProdotto < 0) throw new Error('Colonna Prodotto mancante');

  // Giorni del periodo: legge le due date nell'intestazione (es. 18/06/2026 → 11/08/2026)
  let giorni = 30;
  let periodoTesto = '';
  let dataInizio = null;
  let dataFine = null;

  function parseItaDate(s) {
    // dd/mm/yyyy o dd-mm-yyyy o yyyy-mm-dd
    let m = String(s).trim().match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
    if (m) {
      const d = parseInt(m[1], 10), mo = parseInt(m[2], 10) - 1, y = parseInt(m[3], 10);
      const dt = new Date(y, mo, d);
      if (!isNaN(dt.getTime())) return dt;
    }
    m = String(s).trim().match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
    if (m) {
      const y = parseInt(m[1], 10), mo = parseInt(m[2], 10) - 1, d = parseInt(m[3], 10);
      const dt = new Date(y, mo, d);
      if (!isNaN(dt.getTime())) return dt;
    }
    return null;
  }

  function daysBetween(a, b) {
    const ms = 24 * 60 * 60 * 1000;
    const da = new Date(a.getFullYear(), a.getMonth(), a.getDate());
    const db = new Date(b.getFullYear(), b.getMonth(), b.getDate());
    return Math.max(1, Math.round((db - da) / ms) + 1); // inclusivo
  }

  for (let i = 0; i < headerIdx; i++) {
    const t = (rows[i] || []).map(x => String(x || '')).join(' ');
    // Cerca due date nella stessa riga
    const dateMatches = t.match(/(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4}|\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2})/g);
    if (dateMatches && dateMatches.length >= 2) {
      const d1 = parseItaDate(dateMatches[0]);
      const d2 = parseItaDate(dateMatches[1]);
      if (d1 && d2) {
        dataInizio = d1 <= d2 ? d1 : d2;
        dataFine = d1 <= d2 ? d2 : d1;
        giorni = daysBetween(dataInizio, dataFine);
        const fmt = (d) => String(d.getDate()).padStart(2,'0') + '/' + String(d.getMonth()+1).padStart(2,'0') + '/' + d.getFullYear();
        periodoTesto = fmt(dataInizio) + ' → ' + fmt(dataFine) + ' (' + giorni + ' giorni)';
        break;
      }
    }
    // Fallback: testo "54 giorni"
    const m = t.match(/(\d+)\s*giorni/i);
    if (m && !dataInizio) {
      giorni = parseInt(m[1], 10) || 30;
      periodoTesto = giorni + ' giorni';
    }
  }

  const out = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const nome = r[colProdotto];
    if (!nome || String(nome).trim() === '') continue;
    const venduti = colVenduti >= 0 ? toNum(r[colVenduti]) : null;
    const proiezione = colProiezione >= 0 ? toNum(r[colProiezione]) : null;
    const giacenza = colGiacenza >= 0 ? toNum(r[colGiacenza]) : null;
    const pzCartone = colPz >= 0 ? (toNum(r[colPz]) || 1) : 1;
    let ordineFile = colOrdine >= 0 ? toNum(r[colOrdine]) : null;
    const calc = calcOrdineConsigliato(venduti, giorni, giacenza, proiezione, pzCartone);
    // Se il file ha già ordine consigliato in pezzi, rispettalo ma normalizza a cartoni
    let ordinePezzi = calc.pezzi;
    let ordineCartoni = calc.cartoni;
    let unita = calc.unita;
    if (ordineFile !== null && ordineFile > 0) {
      if (pzCartone > 1) {
        ordineCartoni = Math.ceil(ordineFile / pzCartone);
        // se il valore nel file è piccolo rispetto a pz, potrebbe già essere in cartoni
        if (ordineFile <= 30 && ordineFile < pzCartone) {
          ordineCartoni = Math.ceil(ordineFile);
        }
        ordinePezzi = ordineCartoni * pzCartone;
        unita = 'cartoni';
      } else {
        ordinePezzi = Math.ceil(ordineFile);
        ordineCartoni = ordinePezzi;
        unita = 'pezzi';
      }
    }
    const prio = colPrio >= 0 ? String(r[colPrio] || '').toUpperCase() : '';
    out.push({
      nome: String(nome).trim(),
      codice: colCodice >= 0 ? String(r[colCodice] || '').trim() : '',
      pzCartone: pzCartone > 0 ? pzCartone : 1,
      venduti: venduti,
      proiezione: proiezione,
      giacenza: giacenza,
      ordinePezzi,
      ordineCartoni,
      ordineQty: unita === 'cartoni' ? ordineCartoni : ordinePezzi,
      unita,
      priorita: prio.includes('ALTA') ? 'ALTA' : prio.includes('MEDIA') ? 'MEDIA' : prio.includes('BASSA') ? 'BASSA' : '',
      note: colNote >= 0 ? String(r[colNote] || '') : ''
    });
  }
  return { rows: out, giorni, periodoTesto, dataInizio, dataFine };
}

async function handleParseOrdine() {
  if (!isSantoemma()) {
    showToast('Sezione riservata a Santoemma');
    return;
  }
  const fileInput = document.getElementById('ordine-file');
  const forn = (document.getElementById('ordine-fornitore').value || '').trim();
  const periodo = (document.getElementById('ordine-periodo').value || '').trim();
  const msg = document.getElementById('ordine-parse-msg');
  if (!forn) {
    showToast('Inserisci il nome fornitore');
    return;
  }
  if (!fileInput.files || !fileInput.files[0]) {
    showToast('Seleziona il file Excel');
    return;
  }
  if (typeof XLSX === 'undefined') {
    showToast('Libreria Excel non caricata — serve internet al primo avvio');
    return;
  }
  try {
    const buf = await fileInput.files[0].arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const parsed = parseStatisticaSheet(wb);
    ordineRows = parsed.rows;
    ordineMeta = { fornitore: forn, periodo: periodo || parsed.periodoTesto || (parsed.giorni + ' giorni') };
    const perEl = document.getElementById('ordine-periodo');
    if (perEl && !periodo && parsed.periodoTesto) perEl.value = parsed.periodoTesto;
    showToast('Periodo: ' + ordineMeta.periodo + ' · proiezione 30 gg');
    msg.textContent = 'Importati ' + ordineRows.length + ' prodotti';
    msg.className = 'msg success';
    msg.classList.remove('hidden');
    document.getElementById('ordine-result').classList.remove('hidden');
    renderOrdineTable();
    showToast('Statistica caricata');
  } catch (e) {
    console.error(e);
    msg.textContent = 'Errore: ' + (e.message || e);
    msg.className = 'msg error';
    msg.classList.remove('hidden');
    showToast('File non valido');
  }
}

function filteredOrdineRows() {
  const f = (document.getElementById('ordine-filter') || {}).value || 'da-ordinare';
  let list = [...ordineRows];
  if (f === 'da-ordinare') list = list.filter(r => (r.ordineQty || 0) > 0);
  else if (f === 'alta') list = list.filter(r => r.priorita === 'ALTA' || (r.ordineQty || 0) > 0 && (r.giacenza === null || r.giacenza <= 0));
  list.sort((a, b) => (b.ordineQty || 0) - (a.ordineQty || 0));
  return list;
}

function renderOrdineTable() {
  const wrap = document.getElementById('ordine-table-wrap');
  const summary = document.getElementById('ordine-summary');
  const title = document.getElementById('ordine-result-title');
  if (!wrap) return;
  const list = filteredOrdineRows();
  const daOrd = ordineRows.filter(r => (r.ordineQty || 0) > 0);
  const totPezzi = daOrd.reduce((s, r) => s + (r.unita === 'cartoni' ? (r.ordineQty * r.pzCartone) : r.ordineQty), 0);
  if (title) title.textContent = 'Ordine ' + ordineMeta.fornitore;
  if (summary) {
    summary.textContent = (ordineMeta.periodo ? ordineMeta.periodo + ' · ' : '') +
      daOrd.length + ' riferimenti da ordinare · ~' + totPezzi + ' pezzi totali';
  }
  if (!list.length) {
    wrap.innerHTML = '<p class="muted-center">Nessuna riga in questo filtro</p>';
    return;
  }
  wrap.innerHTML = `<table class="ordine-table">
    <thead>
      <tr>
        <th>Prodotto</th>
        <th>Cod.</th>
        <th>Pz/Ct</th>
        <th>Vend.</th>
        <th>Giac.</th>
        <th>Ordine</th>
        <th>UdM</th>
        <th>Prio</th>
      </tr>
    </thead>
    <tbody>
      ${list.map((r, idx) => {
        const realIdx = ordineRows.indexOf(r);
        const prioCls = r.priorita === 'ALTA' ? 'prio-alta' : r.priorita === 'MEDIA' ? 'prio-media' : 'prio-bassa';
        return `<tr data-idx="${realIdx}">
          <td>${escapeHtml(r.nome)}</td>
          <td>${escapeHtml(r.codice)}</td>
          <td>${r.pzCartone}</td>
          <td>${r.venduti !== null && r.venduti !== undefined ? r.venduti : '—'}</td>
          <td>${r.giacenza !== null && r.giacenza !== undefined ? r.giacenza : '—'}</td>
          <td><input class="ordine-qty" type="number" min="0" step="1" value="${r.ordineQty || 0}" data-idx="${realIdx}"></td>
          <td><span class="ordine-unit">${r.unita === 'cartoni' ? 'cartoni' : 'pz'}</span></td>
          <td class="${prioCls}">${escapeHtml(r.priorita || '')}</td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>`;

  wrap.querySelectorAll('input.ordine-qty').forEach(inp => {
    inp.onchange = () => {
      const i = parseInt(inp.dataset.idx, 10);
      if (ordineRows[i]) {
        ordineRows[i].ordineQty = Math.max(0, parseInt(inp.value, 10) || 0);
        if (ordineRows[i].unita === 'cartoni') {
          ordineRows[i].ordineCartoni = ordineRows[i].ordineQty;
          ordineRows[i].ordinePezzi = ordineRows[i].ordineQty * ordineRows[i].pzCartone;
        } else {
          ordineRows[i].ordinePezzi = ordineRows[i].ordineQty;
          ordineRows[i].ordineCartoni = ordineRows[i].ordineQty;
        }
      }
      const summaryEl = document.getElementById('ordine-summary');
      if (summaryEl) {
        const da = ordineRows.filter(r => (r.ordineQty || 0) > 0);
        const tot = da.reduce((s, r) => s + (r.unita === 'cartoni' ? r.ordineQty * r.pzCartone : r.ordineQty), 0);
        summaryEl.textContent = (ordineMeta.periodo ? ordineMeta.periodo + ' · ' : '') +
          da.length + ' riferimenti da ordinare · ~' + tot + ' pezzi totali';
      }
    };
  });
}

function buildOrdineText() {
  const lines = [];
  lines.push('ORDINE ' + ordineMeta.fornitore.toUpperCase());
  if (ordineMeta.periodo) lines.push('Periodo: ' + ordineMeta.periodo);
  lines.push('Data: ' + todayStr());
  lines.push('Operatore: ' + (currentOperator || ''));
  lines.push('');
  const list = ordineRows.filter(r => (r.ordineQty || 0) > 0)
    .sort((a, b) => (b.ordineQty || 0) - (a.ordineQty || 0));
  list.forEach(r => {
    const qty = r.ordineQty;
    const udm = r.unita === 'cartoni' ? 'cartoni' : 'pz';
    const extra = r.unita === 'cartoni' ? ` (${qty * r.pzCartone} pz)` : '';
    lines.push(`${qty} ${udm}${extra} — ${r.nome}${r.codice ? ' [' + r.codice + ']' : ''}`);
  });
  lines.push('');
  lines.push('Totale riferimenti: ' + list.length);
  return lines.join('\n');
}

async function copyOrdine() {
  const text = buildOrdineText();
  try {
    await navigator.clipboard.writeText(text);
    showToast('Ordine copiato');
  } catch (e) {
    // fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('Ordine copiato');
  }
}

async function shareOrdine() {
  const text = buildOrdineText();
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Ordine ' + ordineMeta.fornitore, text });
      return;
    } catch (e) {}
  }
  await copyOrdine();
}

function clearOrdine() {
  ordineRows = [];
  ordineMeta = { fornitore: '', periodo: '' };
  const file = document.getElementById('ordine-file');
  if (file) file.value = '';
  document.getElementById('ordine-result').classList.add('hidden');
  const msg = document.getElementById('ordine-parse-msg');
  if (msg) msg.classList.add('hidden');
}

function guardOrdiniPage() {
  if (!isSantoemma()) {
    showToast('Sezione riservata a Santoemma');
    showPage('dashboard');
    return false;
  }
  return true;
}

// ---------- Init ----------
async function init() {
  initTheme();

  // --- LOGIN SUBITO (prima di catalogo/cloud, altrimenti iOS resta bloccato sui tasti) ---
  document.querySelectorAll('.operator-btn').forEach(btn => {
    btn.onclick = () => selectOperator(btn.dataset.op);
  });
  const loginBtn = document.getElementById('login-btn');
  const pwdInput = document.getElementById('login-password');
  if (loginBtn) {
    loginBtn.onclick = async () => {
      const op = pendingOperator;
      if (!op) {
        showToast('Seleziona prima un operatore');
        return;
      }
      try {
        const stored = await getOperatorPassword(op);
        if (pwdInput && pwdInput.value === stored) {
          currentOperator = op;
          localStorage.setItem('petstore_operator', op);
          const errEl = document.getElementById('login-error');
          if (errEl) errEl.classList.add('hidden');
          enterApp();
        } else {
          const errEl = document.getElementById('login-error');
          if (errEl) {
            errEl.classList.remove('hidden');
            errEl.textContent = 'Password non corretta per ' + op;
          }
        }
      } catch (e) {
        console.error(e);
        showToast('Errore accesso: ' + (e.message || e));
      }
    };
  }
  if (pwdInput) {
    pwdInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && loginBtn) loginBtn.click();
    });
  }
  const btnBackOps = document.getElementById('btn-back-to-operators');
  if (btnBackOps) {
    btnBackOps.onclick = () => {
      pendingOperator = null;
      document.getElementById('password-screen').classList.add('hidden');
      document.getElementById('login-screen').classList.remove('hidden');
      document.getElementById('login-error').classList.add('hidden');
    };
  }

  // Create Supabase client (library already loaded from index.html)
  try {
    const sb = window.supabase;
    console.log('window.supabase type:', typeof sb, sb);
    if (sb && typeof sb.createClient === 'function') {
      supabase = sb.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    } else if (sb && sb.default && typeof sb.default.createClient === 'function') {
      supabase = sb.default.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    } else {
      throw new Error('Libreria Supabase non trovata. Controlla la connessione internet.');
    }
    console.log('Supabase client OK');
    // Quick connection test (non bloccare il login se fallisce)
    try {
      const { error: testErr } = await supabase.from('scadenze').select('ean').limit(1);
      if (testErr) {
        console.error('Connection test failed:', testErr);
        showToast('Avviso cloud: ' + testErr.message);
      } else {
        console.log('Connection test OK');
      }
    } catch (e) {
      console.warn('Connection test skip', e);
    }
  } catch (err) {
    console.error('Supabase init error:', err);
    showToast('Errore cloud: ' + err.message);
    supabase = null;
  }

  try {
    db = await openDB();
  } catch (e) {
    console.error('IndexedDB open failed', e);
    showToast('Errore memoria locale');
  }

  // Caricamento dati: errori non devono bloccare l'accesso
  try { await loadSupplierConditions(); } catch (e) { console.error(e); }
  try { await loadAccessoryEans(); } catch (e) { console.error(e); }
  try { await loadCatalog(); } catch (e) { console.error(e); showToast('Catalogo non caricato'); }
  try { await loadEanRinomin(); } catch (e) { console.error(e); }
  try { await loadCustomProducts(); } catch (e) { console.error(e); }
  try { applyAccessoriesNoExpiry(); } catch (e) { console.error(e); }
  try { await loadScadenzeFromCloud(); } catch (e) { console.error(e); }
  try { applyAccessoriesNoExpiry(); } catch (e) { console.error(e); }

  const pc = document.getElementById('products-count');
  if (pc) pc.textContent = products.length;

  // Navigation
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.onclick = () => {
      const page = btn.dataset.page;
      showPage(page);
      if (page === 'list') renderFilteredList(document.getElementById('list-filter').value);
      if (page === 'scanner') { /* non avviare in automatico: usa il pulsante */ }
      if (page === 'dashboard') { updateDashboard(); loadBacheca(); updateMyTasksAlert(); loadTurni(); }
      if (page === 'tasks') { loadTasks(); }
      if (page === 'turni') { loadTurni(); }
      if (page === 'missione') { refreshMissione(); }
    };
  });

  document.getElementById('btn-go-scanner').onclick = () => {
    showPage('scanner');
  };
  const btnOrdiniDash = document.getElementById('btn-go-ordini-dash');
  if (btnOrdiniDash) btnOrdiniDash.onclick = () => showPage('ordini');
  document.getElementById('btn-stop-scanner').onclick = stopScanner;
  const btnStartScanner = document.getElementById('btn-start-scanner');
  if (btnStartScanner) {
    btnStartScanner.onclick = async () => {
      btnStartScanner.classList.add('hidden');
      await startScanner();
    };
  }
  document.getElementById('btn-back').onclick = () => {
    const dest = detailReturnPage || 'dashboard';
    detailReturnPage = 'dashboard';
    showPage(dest);
    if (dest === 'dashboard') updateDashboard();
    if (dest === 'missione') { refreshMissione(); }
    if (dest === 'list') {
      const lf = document.getElementById('list-filter');
      renderFilteredList(lf ? lf.value : 'all');
    }
    if (dest === 'non-negozio') renderNonInNegozio();
    if (dest === 'scanner') { /* ok */ }
  };
  const _btnSettings = document.getElementById('btn-settings');
  if (_btnSettings) _btnSettings.onclick = () => showPage('settings');
  document.getElementById('btn-sync').onclick = manualSync;

  const btnNewConsegna = document.getElementById('btn-new-consegna');
  if (btnNewConsegna) btnNewConsegna.onclick = () => openConsegnaForm(null);
  const btnSaveConsegna = document.getElementById('btn-save-consegna');
  if (btnSaveConsegna) btnSaveConsegna.onclick = saveConsegna;
  const btnCancelConsegna = document.getElementById('btn-cancel-consegna');
  if (btnCancelConsegna) btnCancelConsegna.onclick = closeConsegnaForm;
  const btnDeleteConsegna = document.getElementById('btn-delete-consegna');
  if (btnDeleteConsegna) btnDeleteConsegna.onclick = deleteConsegna;
  document.querySelectorAll('#consegne-filters .task-filter-btn').forEach(btn => {
    btn.onclick = () => {
      setConsegneFilter(btn.dataset.cfilter);
      renderConsegne();
    };
  });


  // Logo dropdown menu
  const btnLogoMenu = document.getElementById('btn-logo-menu');
  const logoDropdown = document.getElementById('logo-dropdown');
  function closeLogoMenu() {
    if (logoDropdown) logoDropdown.classList.add('hidden');
    if (btnLogoMenu) btnLogoMenu.classList.remove('open');
  }
  function toggleLogoMenu(e) {
    if (e) e.stopPropagation();
    if (!logoDropdown) return;
    const open = logoDropdown.classList.contains('hidden');
    if (open) {
      logoDropdown.classList.remove('hidden');
      if (btnLogoMenu) btnLogoMenu.classList.add('open');
    } else {
      closeLogoMenu();
    }
  }
  if (btnLogoMenu) btnLogoMenu.onclick = toggleLogoMenu;
  document.querySelectorAll('.logo-dropdown-item').forEach(item => {
    item.onclick = () => {
      const page = item.dataset.page;
      closeLogoMenu();
      showPage(page);
      if (page === 'list') {
        const lf = document.getElementById('list-filter');
        renderFilteredList(lf ? lf.value : 'all');
      }
      if (page === 'scanner') { /* camera on demand */ }
      if (page === 'dashboard') { updateDashboard(); loadBacheca(); updateMyTasksAlert(); loadTurni(); }
      if (page === 'tasks') loadTasks();
      if (page === 'turni') loadTurni();
      if (page === 'missione') refreshMissione();
      if (page === 'non-negozio') { loadNonInNegozio().then(() => renderNonInNegozio()); }
      if (page === 'consegne') { loadConsegne(); }
      if (page === 'ordini') {
        if (!guardOrdiniPage()) return;
      }
      // highlight bottom nav if page has a tab
      document.querySelectorAll('.nav-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.page === page);
      });
    };
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.logo-menu-wrap')) closeLogoMenu();
  });

  const btnParseOrdine = document.getElementById('btn-parse-ordine');
  if (btnParseOrdine) btnParseOrdine.onclick = handleParseOrdine;
  const btnCopyOrdine = document.getElementById('btn-copy-ordine');
  if (btnCopyOrdine) btnCopyOrdine.onclick = copyOrdine;
  const btnShareOrdine = document.getElementById('btn-share-ordine');
  if (btnShareOrdine) btnShareOrdine.onclick = shareOrdine;
  const btnClearOrdine = document.getElementById('btn-clear-ordine');
  if (btnClearOrdine) btnClearOrdine.onclick = clearOrdine;
  const ordineFilter = document.getElementById('ordine-filter');
  if (ordineFilter) ordineFilter.onchange = renderOrdineTable;


  const btnThemeLight = document.getElementById('btn-theme-light');
  if (btnThemeLight) btnThemeLight.onclick = () => { applyTheme('light'); showToast('Modalità chiara'); };
  const btnThemeDark = document.getElementById('btn-theme-dark');
  if (btnThemeDark) btnThemeDark.onclick = () => { applyTheme('dark'); showToast('Modalità scura'); };

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && currentOperator) {
      runSync(true);
    }
  });

  const btnNewSettimana = document.getElementById('btn-new-settimana');
  if (btnNewSettimana) btnNewSettimana.onclick = openNewSettimanaForm;
  const btnSaveTurno = document.getElementById('btn-save-turno');
  if (btnSaveTurno) btnSaveTurno.onclick = saveTurno;
  const btnCancelTurno = document.getElementById('btn-cancel-turno');
  if (btnCancelTurno) btnCancelTurno.onclick = closeTurnoForm;
  const btnCloseViewer = document.getElementById('btn-close-viewer');
  if (btnCloseViewer) btnCloseViewer.onclick = closeTurnoViewer;
  const btnZoomIn = document.getElementById('btn-zoom-in');
  if (btnZoomIn) btnZoomIn.onclick = () => zoomViewer(0.5);
  const btnZoomOut = document.getElementById('btn-zoom-out');
  if (btnZoomOut) btnZoomOut.onclick = () => zoomViewer(-0.5);
  const btnZoomReset = document.getElementById('btn-zoom-reset');
  if (btnZoomReset) btnZoomReset.onclick = () => resetViewerZoom();
  initViewerGestures();
  const turnoInizio = document.getElementById('turno-inizio');
  if (turnoInizio) turnoInizio.addEventListener('change', onInizioChange);
  const turnoFoto = document.getElementById('turno-foto');
  if (turnoFoto) {
    turnoFoto.addEventListener('change', () => {
      const prev = document.getElementById('turno-foto-preview');
      if (turnoFoto.files && turnoFoto.files[0]) {
        const url = URL.createObjectURL(turnoFoto.files[0]);
        prev.innerHTML = '<img src="' + url + '" alt="Anteprima">';
        prev.classList.remove('hidden');
      } else {
        prev.classList.add('hidden');
        prev.innerHTML = '';
      }
    });
  }


  // Bacheca
  const btnNewBacheca = document.getElementById('btn-new-bacheca');
  if (btnNewBacheca) btnNewBacheca.onclick = () => {
    document.getElementById('bacheca-form').classList.toggle('hidden');
  };
  const btnSaveBacheca = document.getElementById('btn-save-bacheca');
  if (btnSaveBacheca) btnSaveBacheca.onclick = saveBacheca;
  const btnCancelBacheca = document.getElementById('btn-cancel-bacheca');
  if (btnCancelBacheca) btnCancelBacheca.onclick = () => {
    document.getElementById('bacheca-form').classList.add('hidden');
  };

  // Tasks
  const btnNewTask = document.getElementById('btn-new-task');
  if (btnNewTask) btnNewTask.onclick = openTaskForm;
  const btnSaveTask = document.getElementById('btn-save-task');
  if (btnSaveTask) btnSaveTask.onclick = saveTask;
  const btnCancelTask = document.getElementById('btn-cancel-task');
  if (btnCancelTask) btnCancelTask.onclick = closeTaskForm;
  document.querySelectorAll('#page-tasks .task-filter-btn').forEach(btn => {
    btn.onclick = () => {
      taskFilter = btn.dataset.filter;
      document.querySelectorAll('#page-tasks .task-filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderTasks();
    };
  });


  populateSupplierSelect();
  const btnGoAdd = document.getElementById('btn-go-add');
  if (btnGoAdd) btnGoAdd.onclick = () => { populateSupplierSelect(); showPage('add'); };
  const btnGoAddDash = document.getElementById('btn-go-add-dash');
  if (btnGoAddDash) btnGoAddDash.onclick = () => { populateSupplierSelect(); showPage('add'); };
  const btnBackAdd = document.getElementById('btn-back-add');
  if (btnBackAdd) btnBackAdd.onclick = () => { showPage('scanner'); };
  const btnSaveNew = document.getElementById('btn-save-new-product');
  if (btnSaveNew) btnSaveNew.onclick = saveNewProduct;


  // Operator change (selezione già collegata all'inizio di init)
  const btnChangeOp = document.getElementById('btn-change-operator');
  if (btnChangeOp) {
    btnChangeOp.onclick = () => {
      if (confirm('Uscire e cambiare operatore? Dovrai inserire di nuovo la password.')) {
        logoutToOperators();
      }
    };
  }
  updateOperatorUI();


  // Search
  let searchTimeout;
  document.getElementById('search-input').addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => doSearch(e.target.value), 250);
  });

  // List filter
  document.getElementById('list-filter').addEventListener('change', (e) => {
    renderFilteredList(e.target.value);
  });

  // Settings
  document.getElementById('btn-change-password').onclick = async () => {
    const n = document.getElementById('new-password').value;
    const c = document.getElementById('confirm-password').value;
    const msg = document.getElementById('password-msg');
    if (!currentOperator) {
      msg.textContent = 'Nessun operatore connesso';
      msg.className = 'msg error';
      return;
    }
    if (n.length < 4) {
      msg.textContent = 'Password troppo corta (min 4 caratteri)';
      msg.className = 'msg error';
      msg.classList.remove('hidden');
      return;
    }
    if (n !== c) {
      msg.textContent = 'Le password non coincidono';
      msg.className = 'msg error';
      msg.classList.remove('hidden');
      return;
    }
    await setOperatorPassword(currentOperator, n);
    msg.textContent = 'Password di ' + currentOperator + ' aggiornata!';
    msg.className = 'msg success';
    msg.classList.remove('hidden');
    document.getElementById('new-password').value = '';
    document.getElementById('confirm-password').value = '';
  };

  document.getElementById('btn-export').onclick = exportData;
  document.getElementById('btn-import').onclick = () => document.getElementById('import-file').click();
  document.getElementById('import-file').addEventListener('change', (e) => {
    if (e.target.files[0]) importData(e.target.files[0]);
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(console.warn);
  }
}

init().catch(console.error);
