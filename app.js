// ===== PetStore Scadenze App + Supabase =====
// VERSION 1.15 - password per operatore + bacheca + task
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
  const meta = await idbGetAll(STORE_META);
  const entry = meta.find(m => m.key === 'pwd_' + opName);
  if (entry && entry.value) return entry.value;
  // Try Supabase
  if (supabase) {
    try {
      const { data } = await supabase.from('operatori_pwd').select('password').eq('nome', opName).maybeSingle();
      if (data && data.password) {
        await idbPut(STORE_META, { key: 'pwd_' + opName, value: data.password });
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

function getBadge(days, signaled) {
  if (signaled) return '<span class="badge signaled">Segnalato</span>';
  if (days === null) return '';
  if (days <= 0) return `<span class="badge expired">${days} gg</span>`;
  if (days <= 7) return `<span class="badge urgent">${days} gg</span>`;
  if (days <= 30) return `<span class="badge attention">${days} gg</span>`;
  if (days <= 120) return `<span class="badge monitor">${days} gg</span>`;
  return `<span class="badge ok">${days} gg</span>`;
}

// ---------- Load catalog (static) ----------
async function loadCatalog() {
  const existing = await idbGetAll(STORE_PRODUCTS);
  if (existing && existing.length > 1000) {
    products = existing;
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
        map[row.ean].lastModified = row.last_modified ? new Date(row.last_modified).getTime() : null;
        map[row.ean].updatedBy = row.updated_by || null;
      }
    });
    products = Object.values(map);
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
      expiry: product.expiry || null,
      signaled: !!product.signaled,
      signaled_date: product.signaledDate || null,
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
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + pageId).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.page === pageId);
  });
  if (pageId !== 'scanner' && isScanning) stopScanner();
}

function renderProductCard(p) {
  const days = daysRemaining(p.expiry);
  const cls = getStatusClass(days);
  const by = p.updatedBy ? `<span class="modified-by">👤 ${escapeHtml(p.updatedBy)}</span>` : '';
  return `
    <div class="product-card ${cls}" data-ean="${p.ean}">
      <div class="product-name">${escapeHtml(p.name)}</div>
      <div class="product-meta">
        <span>${p.ean}</span>
        ${getBadge(days, p.signaled)}
        ${p.supplier ? `<span>${escapeHtml(p.supplier.split(' ')[0])}</span>` : ''}
        ${by}
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
  const withDate = products.filter(p => p.expiry);
  const expired = withDate.filter(p => daysRemaining(p.expiry) <= 0);
  const urgent = withDate.filter(p => { const d = daysRemaining(p.expiry); return d > 0 && d <= 7; });
  const attention = withDate.filter(p => { const d = daysRemaining(p.expiry); return d > 7 && d <= 30; });
  const monitor = withDate.filter(p => { const d = daysRemaining(p.expiry); return d > 30 && d <= 120; });
  const unsignaled = withDate.filter(p => {
    const d = daysRemaining(p.expiry);
    return d !== null && d <= 120 && !p.signaled;
  });

  const signaledCount = products.filter(p => p.signaled).length;

  document.getElementById('stats-grid').innerHTML = `
    <div class="stat-card expired" data-filter="expired">
      <div class="count">${expired.length}</div>
      <div class="label">Scaduti (≤0 gg)</div>
    </div>
    <div class="stat-card urgent" data-filter="urgent">
      <div class="count">${urgent.length}</div>
      <div class="label">Urgenti (≤7 gg)</div>
    </div>
    <div class="stat-card attention" data-filter="attention">
      <div class="count">${attention.length}</div>
      <div class="label">Attenzione (≤30 gg)</div>
    </div>
    <div class="stat-card monitor" data-filter="monitor">
      <div class="count">${monitor.length}</div>
      <div class="label">Da monitorare (≤120)</div>
    </div>
    <div class="stat-card unsignaled" data-filter="unsignaled">
      <div class="count">${unsignaled.length}</div>
      <div class="label">Non segnalati (≤120)</div>
    </div>
    <div class="stat-card signaled" data-filter="signaled" style="grid-column: span 2; background:#eef2ff;">
      <div class="count">${signaledCount}</div>
      <div class="label">✓ Già segnalati — tocca per vedere la lista</div>
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
  let list = products.filter(p => p.expiry);
  if (filter === 'expired') list = list.filter(p => daysRemaining(p.expiry) <= 0);
  else if (filter === 'urgent') list = list.filter(p => { const d = daysRemaining(p.expiry); return d > 0 && d <= 7; });
  else if (filter === 'attention') list = list.filter(p => { const d = daysRemaining(p.expiry); return d > 7 && d <= 30; });
  else if (filter === 'monitor') list = list.filter(p => { const d = daysRemaining(p.expiry); return d > 30 && d <= 120; });
  else if (filter === 'unsignaled') list = list.filter(p => {
    const d = daysRemaining(p.expiry);
    return d !== null && d <= 120 && !p.signaled;
  });
  else if (filter === 'signaled') list = products.filter(p => p.signaled);

  list.sort((a, b) => (daysRemaining(a.expiry) || 9999) - (daysRemaining(b.expiry) || 9999));

  const titles = {
    expired: 'Prodotti scaduti',
    urgent: 'Urgenti (≤7 giorni)',
    attention: 'Attenzione (≤30 giorni)',
    monitor: 'Da monitorare (≤120 giorni)',
    unsignaled: 'Non segnalati',
    signaled: 'Solo segnalati',
    all: 'Tutti con scadenza'
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
    card.onclick = () => openProduct(card.dataset.ean);
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
    card.onclick = () => openProduct(card.dataset.ean);
  });
}

// ---------- Product Detail ----------
function openProduct(ean) {
  currentProduct = products.find(p => p.ean === ean);
  if (!currentProduct) {
    showToast('Prodotto non trovato');
    return;
  }
  const days = daysRemaining(currentProduct.expiry);
  const condition = findCondition(currentProduct.supplier);

  document.getElementById('product-detail').innerHTML = `
    <div class="detail-name">${escapeHtml(currentProduct.name)}</div>
    <div class="detail-ean">EAN: ${currentProduct.ean}</div>

    <div class="detail-row">
      <label>Data di scadenza</label>
      <input type="date" id="detail-expiry" value="${currentProduct.expiry || ''}">
    </div>

    <div class="detail-row">
      <div class="days-display ${getStatusClass(days)}" id="detail-days">
        ${days === null ? 'Nessuna data' : (days <= 0 ? `Scaduto da ${Math.abs(days)} giorni` : `${days} giorni rimanenti`)}
      </div>
    </div>

    <div class="detail-row">
      <label>Stato</label>
      <select id="detail-signaled">
        <option value="false" ${!currentProduct.signaled ? 'selected' : ''}>Non segnalato</option>
        <option value="true" ${currentProduct.signaled ? 'selected' : ''}>Segnalato</option>
      </select>
    </div>

    <div class="detail-row" id="signaled-date-row" style="${currentProduct.signaled ? '' : 'display:none'}">
      <label>Data di segnalazione *</label>
      <input type="date" id="detail-signaled-date" value="${currentProduct.signaledDate || ''}" required>
      <p style="font-size:0.75rem;color:var(--muted);margin-top:4px;">Obbligatoria se il prodotto è segnalato</p>
    </div>

    <div class="detail-row">
      <div class="modified-by" id="detail-modified-by">
        ${currentProduct.updatedBy ? 'Ultima modifica di: <strong>' + escapeHtml(currentProduct.updatedBy) + '</strong>' : 'Nessuna modifica registrata'}
      </div>
    </div>

    <div class="supplier-box">
      <strong>Fornitore</strong>
      ${escapeHtml(currentProduct.supplier) || 'Non specificato'}
      ${condition ? `<div class="conditions-text"><strong>Condizioni reso:</strong><br>${escapeHtml(condition)}</div>` : '<div class="conditions-text">Condizioni non trovate nel database fornitori</div>'}
    </div>

    <button id="btn-save-product" class="btn btn-primary btn-large" style="margin-top:20px;">Salva modifiche</button>
    <button id="btn-delete-product" class="btn btn-danger btn-large" style="margin-top:10px;">🗑️ Elimina prodotto</button>
  `;

  document.getElementById('detail-expiry').addEventListener('change', (e) => {
    const d = daysRemaining(e.target.value);
    const el = document.getElementById('detail-days');
    el.className = 'days-display ' + getStatusClass(d);
    el.textContent = d === null ? 'Nessuna data' : (d <= 0 ? `Scaduto da ${Math.abs(d)} giorni` : `${d} giorni rimanenti`);
  });

  document.getElementById('detail-signaled').addEventListener('change', (e) => {
    const row = document.getElementById('signaled-date-row');
    if (e.target.value === 'true') {
      row.style.display = '';
      const dateInput = document.getElementById('detail-signaled-date');
      if (!dateInput.value) {
        dateInput.value = new Date().toISOString().slice(0, 10);
      }
    } else {
      row.style.display = 'none';
    }
  });

  document.getElementById('btn-save-product').onclick = saveProduct;
  document.getElementById('btn-delete-product').onclick = deleteProduct;
  showPage('detail');
}

async function saveProduct() {
  if (!currentProduct) return;
  const expiry = document.getElementById('detail-expiry').value || null;
  const signaled = document.getElementById('detail-signaled').value === 'true';
  const signaledDateInput = document.getElementById('detail-signaled-date');
  const signaledDate = signaledDateInput ? (signaledDateInput.value || null) : null;

  if (signaled && !signaledDate) {
    showToast('Inserisci la Data di segnalazione (obbligatoria)');
    if (signaledDateInput) signaledDateInput.focus();
    return;
  }

  currentProduct.expiry = expiry;
  currentProduct.signaled = signaled;
  currentProduct.signaledDate = signaled ? signaledDate : null;
  currentProduct.lastModified = Date.now();
  currentProduct.updatedBy = currentOperator || 'Sconosciuto';

  const idx = products.findIndex(p => p.ean === currentProduct.ean);
  if (idx >= 0) products[idx] = currentProduct;

  // Diagnostic
  console.log('=== SAVE DIAGNOSTIC ===');
  console.log('supabase client:', supabase);
  console.log('window.supabase:', typeof window.supabase);

  if (!supabase) {
    showToast('ERRORE: Client Supabase non inizializzato. Ricarica la pagina.');
    updateDashboard();
    return;
  }

  showToast('Salvataggio su cloud in corso...');
  const ok = await saveToCloud(currentProduct);
  if (ok) {
    showToast('Salvato e sincronizzato!');
  }
  // se non ok, saveToCloud ha già mostrato il messaggio di errore specifico
  updateDashboard();
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
    await loadScadenzeFromCloud();
    await loadCustomProducts();
    await loadBacheca();
    await loadTasks();
    await loadTurni();
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
  startAutoSync();
}

function updateOperatorUI() {
  const el = document.getElementById('current-operator');
  if (el) el.textContent = currentOperator || '';
  const settingsName = document.getElementById('settings-operator-name');
  if (settingsName) settingsName.textContent = currentOperator || 'Nessuno';
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
  el.innerHTML = bachecaMessages.map(m => {
    const date = m.created_at ? new Date(m.created_at).toLocaleString('it-IT', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }) : '';
    return `<div class="bacheca-item ${m.fixed ? 'fixed' : ''}">
      <div>${escapeHtml(m.testo)}</div>
      <div class="bacheca-meta">
        <span>${escapeHtml(m.created_by || '')} · ${date}${m.fixed ? ' · 📌' : ''}</span>
        <button class="bacheca-del" data-id="${m.id}">Elimina</button>
      </div>
    </div>`;
  }).join('');
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
  el.innerHTML = `⚠️ Hai <strong>${mine.length}</strong> task da fare` +
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
        <span>👤 ${escapeHtml(resp)}</span>
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

  el.innerHTML = turniList.map(t => {
    const isCur = isCurrentWeek(t.settimana_inizio, t.settimana_fine);
    return `<div class="turno-card ${isCur ? 'oggi' : ''}" data-id="${t.id}">
      <div class="turno-day">${formatRange(t.settimana_inizio, t.settimana_fine)}${isCur ? ' · in corso' : ''}</div>
      ${t.image_url ? `<img class="turno-thumb-sm" src="${t.image_url}" alt="Turni">` : ''}
      ${t.note ? `<div class="turno-note">${escapeHtml(t.note)}</div>` : ''}
      <div class="turno-meta">
        <span>${escapeHtml(t.uploaded_by || '')}</span>
        <span>${t.created_at ? new Date(t.created_at).toLocaleDateString('it-IT') : ''}</span>
      </div>
      <div class="task-actions" style="margin-top:10px;">
        <button class="btn btn-primary btn-view-turno" data-id="${t.id}">Vedi foto</button>
        <button class="btn btn-secondary btn-del-settimana" data-id="${t.id}">Elimina</button>
      </div>
    </div>`;
  }).join('');

  el.querySelectorAll('.btn-view-turno').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const t = turniList.find(x => x.id === btn.dataset.id);
      if (t) openTurnoViewer(t);
    };
  });
  el.querySelectorAll('.btn-del-settimana').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      deleteSettimana(btn.dataset.id);
    };
  });
  el.querySelectorAll('.turno-thumb-sm').forEach(img => {
    img.onclick = (e) => {
      e.stopPropagation();
      const card = img.closest('.turno-card');
      const t = turniList.find(x => x.id === card.dataset.id);
      if (t) openTurnoViewer(t);
    };
  });
}

function updateTurniDash() {
  const el = document.getElementById('turni-dash');
  if (!el) return;
  const current = turniList.find(t => isCurrentWeek(t.settimana_inizio, t.settimana_fine));
  if (current) {
    el.classList.remove('hidden');
    el.innerHTML = '🗓️ Turni settimana: <strong>' + formatRange(current.settimana_inizio, current.settimana_fine) + '</strong> — tocca per vedere';
    el.onclick = () => {
      showPage('turni');
      if (current.image_url) openTurnoViewer(current);
    };
  } else if (turniList.length) {
    el.classList.remove('hidden');
    el.innerHTML = '🗓️ Archivio turni disponibile — tocca per aprire';
    el.onclick = () => showPage('turni');
  } else {
    el.classList.add('hidden');
  }
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

// ---------- Init ----------
async function init() {
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
    // Quick connection test
    const { error: testErr } = await supabase.from('scadenze').select('ean').limit(1);
    if (testErr) {
      console.error('Connection test failed:', testErr);
      showToast('Avviso: ' + testErr.message);
    } else {
      console.log('Connection test OK');
    }
  } catch (err) {
    console.error('Supabase init error:', err);
    showToast('Errore cloud: ' + err.message);
    supabase = null;
  }

  db = await openDB();
  await loadSupplierConditions();
  await loadCatalog();
  await loadScadenzeFromCloud();
  await loadCustomProducts();

  document.getElementById('products-count').textContent = products.length;

  // Login
  const loginBtn = document.getElementById('login-btn');
  const pwdInput = document.getElementById('login-password');
  loginBtn.onclick = async () => {
    const op = pendingOperator;
    if (!op) {
      showToast('Seleziona prima un operatore');
      return;
    }
    const stored = await getOperatorPassword(op);
    if (pwdInput.value === stored) {
      currentOperator = op;
      localStorage.setItem('petstore_operator', op);
      document.getElementById('login-error').classList.add('hidden');
      enterApp();
    } else {
      document.getElementById('login-error').classList.remove('hidden');
      document.getElementById('login-error').textContent = 'Password non corretta per ' + op;
    }
  };
  pwdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loginBtn.click();
  });
  const btnBackOps = document.getElementById('btn-back-to-operators');
  if (btnBackOps) {
    btnBackOps.onclick = () => {
      pendingOperator = null;
      document.getElementById('password-screen').classList.add('hidden');
      document.getElementById('login-screen').classList.remove('hidden');
      document.getElementById('login-error').classList.add('hidden');
    };
  }

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
    };
  });

  document.getElementById('btn-go-scanner').onclick = () => {
    showPage('scanner');
  };
  document.getElementById('btn-stop-scanner').onclick = stopScanner;
  const btnStartScanner = document.getElementById('btn-start-scanner');
  if (btnStartScanner) {
    btnStartScanner.onclick = async () => {
      btnStartScanner.classList.add('hidden');
      await startScanner();
    };
  }
  document.getElementById('btn-back').onclick = () => {
    showPage('dashboard');
    updateDashboard();
  };
  document.getElementById('btn-settings').onclick = () => showPage('settings');
  document.getElementById('btn-sync').onclick = manualSync;
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
  document.querySelectorAll('.task-filter-btn').forEach(btn => {
    btn.onclick = () => {
      taskFilter = btn.dataset.filter;
      document.querySelectorAll('.task-filter-btn').forEach(b => b.classList.remove('active'));
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


  // Operator selection
  document.querySelectorAll('.operator-btn').forEach(btn => {
    btn.onclick = () => selectOperator(btn.dataset.op);
  });
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
