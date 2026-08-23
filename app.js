// ===== PetStore Scadenze App + Supabase =====
// VERSION 2.31 - conteggio sui chip lista
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
let lastScanAt = 0;
let lastScanCode = '';
let scanAudioCtx = null;
let torchOn = false;
let supabase = null;
let scadenzeLogMissing = false;
let noteTableMissing = false;
const EXTRA_TABLES_SQL = `create table if not exists scadenze_log (
  id uuid primary key default gen_random_uuid(),
  ean text not null,
  operator text,
  changed_at timestamptz not null default now(),
  field text not null,
  old_value text,
  new_value text
);
create index if not exists scadenze_log_ean_idx on scadenze_log (ean, changed_at desc);
alter table scadenze_log enable row level security;
drop policy if exists scadenze_log_all on scadenze_log;
create policy scadenze_log_all on scadenze_log for all using (true) with check (true);

create table if not exists prodotti_note (
  ean text primary key,
  note text,
  updated_by text,
  updated_at timestamptz not null default now()
);
alter table prodotti_note enable row level security;
drop policy if exists prodotti_note_all on prodotti_note;
create policy prodotti_note_all on prodotti_note for all using (true) with check (true);

create table if not exists turni_prova (
  settimana_inizio date primary key,
  celle jsonb not null default '{}'::jsonb,
  updated_by text,
  updated_at timestamptz not null default now()
);
alter table turni_prova enable row level security;
drop policy if exists turni_prova_all on turni_prova;
create policy turni_prova_all on turni_prova for all using (true) with check (true);

alter table if exists tasks add column if not exists due_date date;`;
const SCADENZE_LOG_SQL = EXTRA_TABLES_SQL;
const OPERATORS = ['Santoemma', 'Fuschi', 'Pizzimenti', 'Sorrentino'];
const SUPPLIERS_LIST = ["4 HEALTHY PETS NV", "AFFINITY PETCARE ITALIA S.R.L. - DISTRIBUTORE", "AGROMARKET S.R.L.- Distributore Zoodiaco", "ALIVIT DISTRIBUZIONE SRL", "ALMO NATURE S.P.A.PETSTORE", "ASKOLL UNO SRL", "C.I.A.M.S.R.L", "CAMON&CROCI PET GROUP SPA", "COLTIVIA S.R.L.", "DORADO SRL", "FARMAZOO EMILIA SRL", "G.M.DISTRIBUZIONE S.R.L.", "GIA PET DISTRIBUTION SRLS", "GIMBORN ITALIA SRL", "GIUNTI EDITORE SPA", "HILL'S PET NUTRITION ITALIA SRL", "I.G.C. SRL", "IMAC S.R.L.", "IO VEG-CONSORZIO ETICO S.R.L. PETSTORE", "LANDINI GIUNTINI SPA", "LAVIOSA SPA", "LIFE PET CARE SRL", "MARS ITALIA S.P.A.PETSTORE", "ME PET S.R.L.", "MENNUTIGROUP DISTRIBUZIONE S.R.L.", "MONGE & C.S.P.A.PETSTORE ....", "MP GROUP S.R.L.", "MSM PET FOOD SRL", "MYFAMILY S.R.L.", "NATURAL LINE S.R.L.", "NECON PET FOOD SRL", "NESTLE' PURINA COMMERCIALE S.R.L.-PETSTORE", "NEXTMUNE ITALY SRL", "Natua s.r.l.", "OLISTIKA SRL", "PET DISTRIBUZIONE SRL", "PET VILLAGE SRL", "PETCO SRL", "PLATTO SRL", "REAL BOWL SRL", "REBO S.R.L.", "RINALDO FRANCO S.P.A.", "ROYAL CANIN ITALIA S.R.L.", "RUSSO MANGIMI S.P.A.", "SANYPET SPA", "TRE PONTI S.R.L.", "TRIXIE ITALIA SPA", "UNIPRO S.R.L.", "UNITED PETS S.r.l.", "VISAN ITALIA SRL", "VITAKRAFT ITALIA SPA PETSTORE", "WHITEBRIDGE PET BRANDS S.R.L. PETSTORE", "WONDERFOOD ITALIA SRL A SOCIO UNICO"];
let currentOperator = localStorage.getItem('petstore_operator') || null;
let bachecaMessages = [];
let tasksList = [];
let taskFilter = 'miei';
let editingTaskId = null;
let taskDueLocal = {};
let taskDueColumnMissing = false;
let turniList = [];
let editingTurnoDate = null;
let missioneOggi = null;
let missioneProgress = [];
let missioneCompletate = [];
const MISSIONE_COUNT = 20; // obiettivo: coprire tutti i prodotti senza data in 3-4 mesi
const MISSIONE_HOUR = 9;
let detailReturnPage = 'dashboard';
let detailSnapshot = null;
let skipDetailDirty = false;
let pendingDetailLeave = null;
let leaveAfterSave = null;
let nonInNegozio = new Set(); // EANs not in store
let consegneList = [];
let consegneFilter = 'prossime';
let editingConsegnaId = null;
let consegneCalCursor = null;
let consegneCalDay = '';

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
      lastModified: null,
      note: ''
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

async function loadNotesFromCloud() {
  if (!supabase || noteTableMissing) return;
  try {
    const { data, error } = await supabase.from('prodotti_note').select('ean,note');
    if (error) {
      const msg = (error.message || '') + '';
      if (/does not exist|schema cache|42P01/i.test(msg)) noteTableMissing = true;
      return;
    }
    if (!data || !data.length) return;
    const map = {};
    products.forEach(p => { map[p.ean] = p; });
    data.forEach(row => {
      if (map[row.ean]) map[row.ean].note = row.note || '';
    });
  } catch (e) {
    console.warn('prodotti_note:', e);
  }
}

async function saveNoteToCloud(ean, note, oldEan) {
  if (!supabase || noteTableMissing || !ean) return;
  const text = (note || '').trim().slice(0, 280);
  try {
    if (oldEan && oldEan !== ean) {
      await supabase.from('prodotti_note').delete().eq('ean', oldEan);
    }
    if (!text) {
      await supabase.from('prodotti_note').delete().eq('ean', ean);
      return;
    }
    const { error } = await supabase.from('prodotti_note').upsert({
      ean,
      note: text,
      updated_by: currentOperator || 'Sconosciuto',
      updated_at: new Date().toISOString()
    }, { onConflict: 'ean' });
    if (error) {
      const msg = (error.message || '') + '';
      if (/does not exist|schema cache|42P01/i.test(msg)) noteTableMissing = true;
    }
  } catch (e) {
    console.warn('save note:', e);
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
    showToast('Cloud non disponibile — salvato solo su questo telefono', 'warn');
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
      showToast('Errore cloud: ' + (error.message || JSON.stringify(error)), 'error');
      return false;
    }
    console.log('Save success:', data);
    return true;
  } catch (err) {
    console.error('Save exception:', err);
    showToast('Errore di rete: ' + err.message, 'error');
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
let toastTimer = null;
function inferToastType(msg) {
  const m = String(msg || '').toLowerCase();
  if (/in corso/.test(m)) return 'info';
  if (/errore|impossibile|non valido|non trovato|obbligatoria|non inizializzato/.test(m)) return 'error';
  if (/locale|cloud non|non disponibile|attenzione|avviso|non caricat|libreria excel/.test(m)) return 'warn';
  if (/salvato|sincronizzat|completata|completato|pubblicato|archiviato|eliminat|aggiunto|creato|caricata|copiato|aggiornato|consegn/.test(m)) return 'success';
  return 'info';
}
function showToast(msg, duration, type) {
  if (typeof duration === 'string') {
    type = duration;
    duration = 2800;
  }
  duration = duration || 2800;
  type = type || inferToastType(msg);
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'toast toast-' + type;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), duration);
}

function showPage(pageId) {
  if (pageId === 'ordini' && currentOperator !== 'Santoemma') {
    showToast('Sezione riservata a Santoemma');
    pageId = 'dashboard';
  }

  const detailEl = document.getElementById('page-detail');
  const onDetail = detailEl && detailEl.classList.contains('active');
  if (!skipDetailDirty && onDetail && pageId !== 'detail' && isDetailDirty()) {
    pendingDetailLeave = pageId;
    openUnsavedDialog();
    return false;
  }

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + pageId).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.page === pageId);
  });
  if (pageId !== 'scanner' && isScanning) stopScanner();
  if (pageId !== 'detail') detailSnapshot = null;
  return true;
}

function getDetailFormState() {
  return {
    ean: ((document.getElementById('detail-ean') || {}).value || '').trim(),
    expiry: (document.getElementById('detail-expiry') || {}).value || '',
    noExpiry: !!(document.getElementById('detail-no-expiry') && document.getElementById('detail-no-expiry').checked),
    signaled: (document.getElementById('detail-signaled') || {}).value || 'false',
    signaledDate: (document.getElementById('detail-signaled-date') || {}).value || '',
    note: ((document.getElementById('detail-note') || {}).value || '').trim()
  };
}

function isDetailDirty() {
  if (!detailSnapshot) return false;
  if (!document.getElementById('detail-ean')) return false;
  return JSON.stringify(getDetailFormState()) !== JSON.stringify(detailSnapshot);
}

function captureDetailSnapshot() {
  detailSnapshot = getDetailFormState();
}

function openUnsavedDialog() {
  const el = document.getElementById('unsaved-overlay');
  if (el) el.classList.remove('hidden');
}

function closeUnsavedDialog() {
  const el = document.getElementById('unsaved-overlay');
  if (el) el.classList.add('hidden');
}

function runPageEnter(page) {
  if (page === 'list') {
    const lf = document.getElementById('list-filter');
    renderFilteredList(lf ? lf.value : 'all');
  }
  if (page === 'dashboard') {
    updateDashboard();
    loadBacheca();
    updateMyTasksAlert();
    loadTurni();
    loadOggiTurniDash();
  }
  if (page === 'tasks') loadTasks();
  if (page === 'turni') loadTurni();
  if (page === 'turni-prova') loadTurniProva();
  if (page === 'missione') refreshMissione();
  if (page === 'non-negozio') loadNonInNegozio().then(() => renderNonInNegozio());
  if (page === 'consegne') loadConsegne();
}

function discardUnsavedAndLeave() {
  const dest = pendingDetailLeave || detailReturnPage || 'dashboard';
  pendingDetailLeave = null;
  closeUnsavedDialog();
  detailSnapshot = null;
  skipDetailDirty = true;
  showPage(dest);
  skipDetailDirty = false;
  detailReturnPage = 'dashboard';
  runPageEnter(dest);
}

async function saveUnsavedAndLeave() {
  const dest = pendingDetailLeave || 'scanner';
  pendingDetailLeave = null;
  closeUnsavedDialog();
  leaveAfterSave = dest;
  await saveProduct();
}

function cancelUnsavedLeave() {
  pendingDetailLeave = null;
  closeUnsavedDialog();
}

function needsQuickSignal(p) {
  if (!p || p.noExpiry || p.signaled || !p.expiry) return false;
  const d = daysRemaining(p.expiry);
  return d !== null && d <= 120;
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
      ${p.note ? `<p class="product-note">${escapeHtml(p.note)}</p>` : ''}
      ${needsQuickSignal(p) ? `<button type="button" class="btn btn-primary btn-signal-list" data-ean="${escapeHtml(p.ean)}">Segnala</button>` : ''}
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
      setListFilter(card.dataset.filter);
      showPage('list');
    };
  });
  updateSegnalareCount();
  if (typeof updateMissioneDash === 'function') updateMissioneDash();
  renderSyncStatus();
}

function countUnsignaled() {
  return products.filter(p => {
    if (!p.expiry || p.noExpiry || p.signaled) return false;
    const d = daysRemaining(p.expiry);
    return d !== null && d <= 120;
  }).length;
}

function updateSegnalareCount() {
  const el = document.getElementById('segnalare-count');
  if (!el) return;
  const n = countUnsignaled();
  el.textContent = String(n);
  el.classList.toggle('is-zero', n === 0);
}
window.updateSegnalareCount = updateSegnalareCount;

let lastSyncAt = 0;
let lastSyncOk = true;
try {
  lastSyncAt = parseInt(localStorage.getItem('petstore_last_sync') || '0', 10) || 0;
  lastSyncOk = localStorage.getItem('petstore_last_sync_ok') !== '0';
} catch (e) {}

function formatSyncTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const time = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return time;
  return d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' }) + ' · ' + time;
}

function markSync(ok) {
  lastSyncAt = Date.now();
  lastSyncOk = !!ok;
  try {
    localStorage.setItem('petstore_last_sync', String(lastSyncAt));
    localStorage.setItem('petstore_last_sync_ok', lastSyncOk ? '1' : '0');
  } catch (e) {}
  renderSyncStatus();
}

function renderSyncStatus() {
  const el = document.getElementById('sync-status');
  if (!el) return;
  el.classList.remove('is-warn', 'is-ok');
  if (!lastSyncAt) {
    el.textContent = 'Mai sincronizzato · tocca per aggiornare';
    el.classList.add('is-warn');
  } else if (lastSyncOk) {
    el.textContent = 'Sincronizzato alle ' + formatSyncTime(lastSyncAt) + ' · tocca per aggiornare';
    el.classList.add('is-ok');
  } else {
    el.textContent = 'Solo locale · ' + formatSyncTime(lastSyncAt) + ' · tocca per riprovare';
    el.classList.add('is-warn');
  }
  el.onclick = () => { if (typeof manualSync === 'function') manualSync(); };
}

// ---------- List / Filter ----------
function setListFilter(filter) {
  const lf = document.getElementById('list-filter');
  if (lf) lf.value = filter;
  renderFilteredList(filter);
}
window.setListFilter = setListFilter;

function emptyStateHtml(title, text, action, actionLabel) {
  const btn = action
    ? `<button type="button" class="btn btn-primary empty-action" data-empty-action="${action}">${escapeHtml(actionLabel || 'Ok')}</button>`
    : '';
  return `<div class="empty-state">
    <p class="empty-title">${escapeHtml(title)}</p>
    <p class="empty-text">${escapeHtml(text)}</p>
    ${btn}
  </div>`;
}

function wireEmptyActions(container) {
  if (!container) return;
  container.querySelectorAll('[data-empty-action]').forEach(btn => {
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleEmptyAction(btn.dataset.emptyAction);
    };
  });
}

function handleEmptyAction(action) {
  if (action === 'scanner') {
    showPage('scanner');
  } else if (action === 'add' || action === 'add-from-search') {
    const q = ((document.getElementById('search-input') || {}).value || '').trim();
    showPage('add');
    if (action === 'add-from-search' && q) {
      if (/^\d{8,14}$/.test(q)) {
        const ean = document.getElementById('add-ean');
        if (ean) ean.value = q;
      } else {
        const name = document.getElementById('add-name');
        if (name) name.value = q;
      }
    }
  } else if (action === 'home') {
    showPage('dashboard');
    updateDashboard();
  } else if (action === 'list-attention') {
    setListFilter('attention');
    showPage('list');
  } else if (action === 'list-monitor') {
    setListFilter('monitor');
    showPage('list');
  } else if (action === 'list-signaled') {
    setListFilter('signaled');
    showPage('list');
  } else if (action === 'list-unsignaled') {
    setListFilter('unsignaled');
    showPage('list');
  } else if (action === 'list-supplier-all') {
    const sel = document.getElementById('list-supplier');
    if (sel) sel.value = '';
    renderFilteredList((document.getElementById('list-filter') || {}).value || 'all');
  } else if (action === 'list-search-clear') {
    const inp = document.getElementById('list-search');
    if (inp) inp.value = '';
    renderFilteredList((document.getElementById('list-filter') || {}).value || 'all');
  } else if (action === 'new-task') {
    const b = document.getElementById('btn-new-task');
    if (b) b.click();
  } else if (action === 'new-consegna') {
    const b = document.getElementById('btn-new-consegna');
    if (b) b.click();
  } else if (action === 'new-bacheca') {
    const b = document.getElementById('btn-new-bacheca');
    if (b) b.click();
  } else if (action === 'new-settimana') {
    const b = document.getElementById('btn-new-settimana');
    if (b) b.click();
  } else if (action === 'ordine-tutti') {
    setOrdineFilter('tutti');
  }
}

function getListForFilter(filter, opts) {
  opts = opts || {};
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

  if (!opts.countsOnly) {
    const wanted = getSelectedListSupplier();
    if (wanted) list = list.filter(p => supplierMatches(p, wanted));
    const q = getListSearchQuery();
    if (q.length >= 2) list = list.filter(p => productMatchesListSearch(p, q));
    if (filter === 'all' || filter === 'no-date' || filter === 'no-expiry') {
      list.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'it'));
    } else {
      list.sort((a, b) => (daysRemaining(a.expiry) || 9999) - (daysRemaining(b.expiry) || 9999));
    }
  }
  return list;
}

function updateListChipCounts() {
  document.querySelectorAll('.list-chip').forEach(ch => {
    const n = getListForFilter(ch.dataset.filter, { countsOnly: true }).length;
    const lab = ch.dataset.label || ch.textContent.replace(/\s*\(\d+\)\s*$/, '').trim();
    ch.dataset.label = lab;
    ch.textContent = lab + ' (' + n + ')';
  });
}

function getSelectedListSupplier() {
  const sel = document.getElementById('list-supplier');
  return sel ? (sel.value || '') : '';
}

function getListSearchQuery() {
  return ((document.getElementById('list-search') || {}).value || '').trim().toLowerCase();
}

function productMatchesListSearch(p, q) {
  if (!q) return true;
  const name = (p.name || '').toLowerCase();
  const ean = String(p.ean || '').toLowerCase();
  const note = (p.note || '').toLowerCase();
  return name.includes(q) || ean.includes(q) || note.includes(q);
}

function supplierMatches(p, wanted) {
  if (!wanted) return true;
  const s = (p.supplier || '').trim();
  if (wanted === '__none__') return !s;
  return s === wanted;
}

function fillListSupplierSelect() {
  const sel = document.getElementById('list-supplier');
  if (!sel) return;
  const prev = sel.value;
  const counts = {};
  let none = 0;
  products.forEach(p => {
    const s = (p.supplier || '').trim();
    if (!s) { none++; return; }
    counts[s] = (counts[s] || 0) + 1;
  });
  const names = Object.keys(counts).sort((a, b) => a.localeCompare(b, 'it'));
  sel.innerHTML = '<option value="">Tutti i fornitori</option>' +
    '<option value="__none__">Senza fornitore (' + none + ')</option>' +
    names.map(n => '<option value="' + escapeHtml(n) + '">' + escapeHtml(n) + ' (' + counts[n] + ')</option>').join('');
  if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
  sel.classList.toggle('is-on', !!sel.value);
  const clr = document.getElementById('btn-clear-supplier');
  if (clr) clr.classList.toggle('hidden', !sel.value);
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  if (/[;"\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function formatExportDate(iso) {
  if (!iso) return '';
  const s = String(iso);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const [y, m, d] = s.slice(0, 10).split('-');
    return d + '/' + m + '/' + y;
  }
  return s;
}

function buildListCsv(list) {
  const header = ['Nome', 'EAN', 'Fornitore', 'Scadenza', 'Giorni', 'Segnalato', 'Data segnalazione', 'Senza scadenza', 'Nota', 'Modificato da'];
  const rows = list.map(p => {
    const days = p.noExpiry ? '' : (p.expiry ? daysRemaining(p.expiry) : '');
    return [
      csvCell(p.name || ''),
      csvCell(p.ean || ''),
      csvCell(p.supplier || ''),
      csvCell(p.noExpiry ? '' : formatExportDate(p.expiry)),
      csvCell(days === '' || days === null ? '' : days),
      csvCell(p.signaled ? 'sì' : 'no'),
      csvCell(formatExportDate(p.signaledDate)),
      csvCell(p.noExpiry ? 'sì' : 'no'),
      csvCell(p.note || ''),
      csvCell(p.updatedBy || '')
    ].join(';');
  });
  return header.join(';') + '\n' + rows.join('\n');
}

async function exportCurrentList() {
  const filter = (document.getElementById('list-filter') || {}).value || 'all';
  const list = getListForFilter(filter);
  if (!list.length) {
    showToast('Lista vuota, niente da esportare', 'warn');
    return;
  }
  const slugs = {
    all: 'senza-data',
    'no-date': 'senza-data',
    expired: 'scaduti',
    urgent: '7giorni',
    attention: '30giorni',
    monitor: '120giorni',
    unsignaled: 'da-segnalare',
    signaled: 'segnalati',
    'no-expiry': 'esclusi',
    'with-date': 'con-data'
  };
  const today = new Date();
  const stamp = String(today.getDate()).padStart(2, '0') + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + today.getFullYear();
  const wanted = getSelectedListSupplier();
  let extra = '';
  if (wanted === '__none__') extra = '-senza-fornitore';
  else if (wanted) extra = '-' + wanted.toLowerCase().replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 24);
  const filename = 'scadenze-' + (slugs[filter] || filter) + extra + '-' + stamp + '.csv';
  const blob = new Blob(['\uFEFF' + buildListCsv(list)], { type: 'text/csv;charset=utf-8;' });
  const file = new File([blob], filename, { type: 'text/csv' });
  if (navigator.share && navigator.canShare) {
    try {
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename, text: list.length + ' prodotti' });
        showToast('Lista condivisa (' + list.length + ')', 'success');
        return;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  showToast('Esportati ' + list.length + ' prodotti', 'success');
}

function printCurrentList() {
  const filter = (document.getElementById('list-filter') || {}).value || 'all';
  const list = getListForFilter(filter);
  if (!list.length) {
    showToast('Lista vuota, niente da stampare', 'warn');
    return;
  }
  const title = ((document.getElementById('list-title') || {}).textContent || 'Lista scadenze').trim();
  const rows = list.map(p => {
    const days = p.noExpiry ? '—' : (p.expiry == null || p.expiry === '' ? '—' : String(daysRemaining(p.expiry)));
    const exp = p.noExpiry ? 'escluso' : (formatExportDate(p.expiry) || '—');
    const sig = p.signaled ? ' *' : '';
    return '<tr><td class="n">' + escapeHtml((p.name || '') + sig) + '</td><td class="ean">' + escapeHtml(p.ean || '') + '</td><td>' + escapeHtml(p.supplier || '') + '</td><td>' + escapeHtml(exp) + '</td><td class="d">' + escapeHtml(days) + '</td></tr>';
  }).join('');
  const html = `<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><title>${escapeHtml(title)}</title>
<style>
@page { size: A4 portrait; margin: 10mm; }
* { box-sizing: border-box; }
body { margin: 0; color: #000; background: #fff; font-family: Arial, Helvetica, sans-serif; }
h1 { font-size: 15px; margin: 0 0 4px; }
.meta { font-size: 11px; margin: 0 0 10px; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th, td { border: 1px solid #000; padding: 4px 5px; font-size: 10px; vertical-align: top; word-wrap: break-word; }
th { text-align: left; font-size: 10px; }
.n { width: 34%; }
.ean { width: 18%; font-variant-numeric: tabular-nums; }
.d { width: 10%; text-align: right; }
.leg { margin-top: 8px; font-size: 10px; }
@media print { button { display: none !important; } }
.no-print { margin-top: 10px; }
</style></head><body>
<h1>Pet Store La Malfa — ${escapeHtml(title)}</h1>
<p class="meta">${list.length} prodotti · ${escapeHtml(new Date().toLocaleDateString('it-IT'))} · * = segnalato</p>
<table>
<thead><tr><th class="n">Nome</th><th class="ean">EAN</th><th>Fornitore</th><th>Scadenza</th><th class="d">Gg</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<p class="leg">Stampa della lista filtrata in app (fascia, fornitore, ricerca).</p>
<p class="no-print"><button onclick="window.print()">Stampa / Salva PDF</button></p>
<script>window.onload=function(){setTimeout(function(){window.print();},250);}</script>
</body></html>`;
  const w = window.open('', '_blank');
  if (!w) {
    showToast('Consenti i popup per stampare', 'warn');
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

function renderFilteredList(filter) {
  fillListSupplierSelect();
  updateListChipCounts();
  const list = getListForFilter(filter);
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
  let title = titles[filter] || 'Lista prodotti';
  const wanted = getSelectedListSupplier();
  if (wanted === '__none__') title += ' · senza fornitore';
  else if (wanted) title += ' · ' + wanted;
  document.getElementById('list-title').textContent = title;

  const lf = document.getElementById('list-filter');
  if (lf && lf.value !== filter) lf.value = filter;
  document.querySelectorAll('.list-chip').forEach(ch => {
    ch.classList.toggle('active', ch.dataset.filter === filter);
  });

  const container = document.getElementById('filtered-list');
  const searchQ = getListSearchQuery();
  if (list.length === 0) {
    if (searchQ.length >= 2) {
      container.innerHTML = emptyStateHtml(
        'Nessun risultato in questa fascia',
        'Nessun prodotto corrisponde a “' + searchQ + '” con i filtri attivi.',
        'list-search-clear',
        'Cancella ricerca'
      );
      wireEmptyActions(container);
    } else if (wanted) {
      const label = wanted === '__none__' ? 'prodotti senza fornitore' : wanted;
      container.innerHTML = emptyStateHtml(
        'Nessun prodotto di questo fornitore',
        'In questa fascia non ci sono articoli di ' + label + '.',
        'list-supplier-all',
        'Togli filtro fornitore'
      );
      wireEmptyActions(container);
    } else {
    const emptyByFilter = {
      all: ['Nessun prodotto senza data', 'Tutti i prodotti hanno una scadenza oppure sono esclusi dal controllo.', 'scanner', 'Vai allo scanner'],
      'no-date': ['Nessun prodotto senza data', 'Tutti i prodotti hanno una scadenza oppure sono esclusi dal controllo.', 'scanner', 'Vai allo scanner'],
      expired: ['Nessun prodotto scaduto', 'In questo momento non ci sono articoli oltre la data.', 'home', 'Torna in Home'],
      urgent: ['Nessun prodotto a 7 giorni', 'Niente di urgente in questa fascia. Controlla i 30 giorni se serve.', 'list-attention', 'Vedi 30 giorni'],
      attention: ['Nessun prodotto a 30 giorni', 'Nessun articolo in questa fascia. Puoi passare ai 120 giorni.', 'list-monitor', 'Vedi 120 giorni'],
      monitor: ['Nessun prodotto a 120 giorni', 'Nessun articolo da monitorare in questa fascia.', 'home', 'Torna in Home'],
      unsignaled: ['Tutto già segnalato', 'I prodotti in scadenza risultano già segnalati.', 'list-signaled', 'Vedi segnalati'],
      signaled: ['Nessun prodotto segnalato', 'Non ci sono ancora segnalazioni registrate.', 'list-unsignaled', 'Vedi da segnalare'],
      'no-expiry': ['Nessun prodotto escluso', 'Nessun articolo è stato segnato come senza scadenza.', 'scanner', 'Vai allo scanner'],
      'with-date': ['Nessun prodotto con data', 'Non risultano ancora scadenze inserite.', 'scanner', 'Vai allo scanner']
    };
    const cfg = emptyByFilter[filter] || ['Lista vuota', 'Nessun prodotto in questa vista.', 'home', 'Torna in Home'];
    container.innerHTML = emptyStateHtml(cfg[0], cfg[1], cfg[2], cfg[3]);
    wireEmptyActions(container);
    }
  } else {
    container.innerHTML = list.slice(0, 300).map(renderProductCard).join('') +
      (list.length > 300 ? `<p style="text-align:center;color:#64748b;">... e altri ${list.length - 300}</p>` : '');
  }
  container.querySelectorAll('.product-card').forEach(card => {
    card.onclick = () => openProduct(card.dataset.ean, 'list');
  });
  wireSignalButtons(container);
}

async function quickSignalProduct(ean) {
  const p = products.find(x => x.ean === ean);
  if (!p) return;
  if (!needsQuickSignal(p)) {
    showToast('Già segnalato o senza data in scadenza', 'info');
    return;
  }
  const today = todayStr();
  const before = {
    ean: p.ean,
    expiry: p.expiry || null,
    signaled: !!p.signaled,
    signaledDate: p.signaledDate || null,
    noExpiry: !!p.noExpiry,
    note: (p.note || '').trim()
  };
  p.signaled = true;
  p.signaledDate = today;
  p.lastModified = Date.now();
  p.updatedBy = currentOperator || 'Sconosciuto';
  showToast('Segnalazione in corso...', 'info');
  const ok = await saveToCloud(p);
  try { await idbPut(STORE_PRODUCTS, p); } catch (e) {}
  if (ok) {
    await logProductChanges(before, {
      ean: p.ean,
      expiry: p.expiry || null,
      signaled: true,
      signaledDate: today,
      noExpiry: !!p.noExpiry,
      note: (p.note || '').trim()
    });
    showToast('Segnalato', 'success');
  } else {
    showToast('Segnalato in locale — il collega non lo vede ancora', 'warn');
  }
  updateDashboard();
  const listPage = document.getElementById('page-list');
  if (listPage && listPage.classList.contains('active')) {
    const lf = document.getElementById('list-filter');
    renderFilteredList(lf ? lf.value : 'all');
  }
  const scanPage = document.getElementById('page-scanner');
  if (scanPage && scanPage.classList.contains('active')) {
    const q = (document.getElementById('search-input') || {}).value || '';
    if (q.trim().length >= 2) doSearch(q);
  }
}

function wireSignalButtons(container) {
  if (!container) return;
  container.querySelectorAll('.btn-signal-list').forEach(btn => {
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      quickSignalProduct(btn.dataset.ean);
    };
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
  if (results.length) {
    container.innerHTML = results.map(renderProductCard).join('');
  } else {
    container.innerHTML = emptyStateHtml(
      'Nessun risultato',
      'Nessun prodotto trovato per “' + query + '”. Controlla l’EAN o aggiungilo al catalogo.',
      'add-from-search',
      'Aggiungi prodotto'
    );
    wireEmptyActions(container);
    return;
  }
  container.querySelectorAll('.product-card').forEach(card => {
    card.onclick = () => openProduct(card.dataset.ean, 'scanner');
  });
  wireSignalButtons(container);
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
      <div class="detail-row">
        <label>Nota</label>
        <textarea id="detail-note" rows="3" maxlength="280" placeholder="Es. seconda fila, solo 2 pezzi, da spostare…">${escapeHtml(currentProduct.note || '')}</textarea>
        <p class="field-hint">Visibile a tutti gli operatori. Max 280 caratteri.</p>
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

    <div class="detail-block" id="product-history-block">
      <p class="detail-kicker">Storico scadenze</p>
      <div id="product-history" class="product-history"><p class="history-empty">Caricamento...</p></div>
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
  captureDetailSnapshot();
  loadProductHistory(currentProduct.ean);
}

function formatLogValue(val) {
  if (val === null || val === undefined || val === '') return '—';
  const s = String(val);
  if (s.length > 48) return s.slice(0, 46) + '…';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const [y, m, d] = s.slice(0, 10).split('-');
    return d + '/' + m + '/' + y;
  }
  return s;
}

function formatLogField(field) {
  const map = {
    ean: 'EAN',
    expiry: 'Scadenza',
    signaled: 'Segnalato',
    signaled_date: 'Data segnalazione',
    no_expiry: 'Senza scadenza',
    note: 'Nota'
  };
  return map[field] || field;
}

function formatLogWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const SCADENZE_LOG_LS = 'petstore_scadenze_log';

function readLocalScadenzeLog() {
  try {
    const arr = JSON.parse(localStorage.getItem(SCADENZE_LOG_LS) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

function writeLocalScadenzeLog(arr) {
  try { localStorage.setItem(SCADENZE_LOG_LS, JSON.stringify((arr || []).slice(0, 500))); } catch (e) {}
}

function markLogTableMissing(error) {
  const msg = (error && (error.message || error.code || '')) + '';
  if (/does not exist|schema cache|42P01|scadenze_log/i.test(msg)) {
    scadenzeLogMissing = true;
  }
}

function buildProductLogRows(before, after) {
  const rows = [];
  const push = (field, oldV, newV) => {
    const a = oldV == null || oldV === '' ? '' : String(oldV);
    const b = newV == null || newV === '' ? '' : String(newV);
    if (a === b) return;
    rows.push({
      ean: after.ean,
      operator: currentOperator || 'Sconosciuto',
      field,
      old_value: a || null,
      new_value: b || null,
      changed_at: new Date().toISOString()
    });
  };
  push('ean', before.ean, after.ean);
  push('expiry', before.expiry, after.expiry);
  push('no_expiry', before.noExpiry ? 'sì' : 'no', after.noExpiry ? 'sì' : 'no');
  push('signaled', before.signaled ? 'sì' : 'no', after.signaled ? 'sì' : 'no');
  push('signaled_date', before.signaledDate, after.signaledDate);
  push('note', before.note, after.note);
  return rows;
}

async function writeProductLog(before, after) {
  const rows = buildProductLogRows(before, after);
  if (!rows.length) return;
  writeLocalScadenzeLog(rows.concat(readLocalScadenzeLog()));
  if (!supabase || scadenzeLogMissing) return;
  try {
    if (before.ean && after.ean && before.ean !== after.ean) {
      await supabase.from('scadenze_log').update({ ean: after.ean }).eq('ean', before.ean);
    }
    const { error } = await supabase.from('scadenze_log').insert(rows.map(r => ({
      ean: r.ean,
      operator: r.operator,
      field: r.field,
      old_value: r.old_value,
      new_value: r.new_value
    })));
    if (error) {
      console.warn('scadenze_log insert:', error);
      markLogTableMissing(error);
    }
  } catch (e) {
    console.warn('scadenze_log:', e);
    markLogTableMissing(e);
  }
}

function logProductChanges(before, after) {
  return writeProductLog(before, after);
}

function historyLine(r) {
  const who = r.operator || 'Operatore';
  if (r.field === 'expiry') {
    return who + ' ha cambiato la scadenza da ' + formatLogValue(r.old_value) + ' a ' + formatLogValue(r.new_value);
  }
  if (r.field === 'no_expiry') {
    return who + ' ha impostato senza scadenza: ' + formatLogValue(r.new_value);
  }
  return formatLogField(r.field) + ': ' + formatLogValue(r.old_value) + ' → ' + formatLogValue(r.new_value);
}

function renderProductHistory(rows) {
  const el = document.getElementById('product-history');
  if (!el) return;
  if (!rows || !rows.length) {
    el.innerHTML = '<p class="history-empty">Nessuna modifica registrata ancora. Si aggiorna quando salvi una scadenza diversa.</p>';
    return;
  }
  el.innerHTML = rows.map(r => {
    const expiry = r.field === 'expiry' || r.field === 'no_expiry';
    return `<div class="history-item${expiry ? ' is-expiry' : ''}">
      <div class="history-what"><strong>${escapeHtml(historyLine(r))}</strong></div>
      <div class="history-meta">${escapeHtml(formatLogWhen(r.changed_at))}</div>
    </div>`;
  }).join('');
}

function mergeProductHistory(cloud, ean) {
  const local = readLocalScadenzeLog().filter(r => r.ean === ean || r.ean === (currentProduct && currentProduct.ean));
  const key = r => [r.field, r.old_value, r.new_value, (r.changed_at || '').slice(0, 16), r.operator].join('|');
  const seen = {};
  const out = [];
  (cloud || []).concat(local).forEach(r => {
    const k = key(r);
    if (seen[k]) return;
    seen[k] = true;
    out.push(r);
  });
  out.sort((a, b) => String(b.changed_at || '').localeCompare(String(a.changed_at || '')));
  return out.slice(0, 20);
}

async function loadProductHistory(ean) {
  const el = document.getElementById('product-history');
  if (!el || !ean) return;
  let cloud = [];
  if (supabase && !scadenzeLogMissing) {
    try {
      const { data, error } = await supabase
        .from('scadenze_log')
        .select('ean,operator,changed_at,field,old_value,new_value')
        .eq('ean', ean)
        .order('changed_at', { ascending: false })
        .limit(30);
      if (error) markLogTableMissing(error);
      else cloud = data || [];
    } catch (e) {
      markLogTableMissing(e);
    }
  }
  renderProductHistory(mergeProductHistory(cloud, ean));
}

async function saveProduct() {
  if (!currentProduct) return;
  const oldEan = currentProduct.ean;
  const before = {
    ean: currentProduct.ean,
    expiry: currentProduct.expiry || null,
    signaled: !!currentProduct.signaled,
    signaledDate: currentProduct.signaledDate || null,
    noExpiry: !!currentProduct.noExpiry,
    note: (currentProduct.note || '').trim()
  };
  const eanInput = document.getElementById('detail-ean');
  const newEan = ((eanInput && eanInput.value) || '').trim().replace(/\D/g, '');
  const noExpiry = !!(document.getElementById('detail-no-expiry') && document.getElementById('detail-no-expiry').checked);
  const expiryEl = document.getElementById('detail-expiry');
  const expiry = noExpiry ? null : ((expiryEl && expiryEl.value) || null);
  const sigEl = document.getElementById('detail-signaled');
  const signaled = noExpiry ? false : (sigEl && sigEl.value === 'true');
  const signaledDateInput = document.getElementById('detail-signaled-date');
  const signaledDate = noExpiry ? null : (signaledDateInput ? (signaledDateInput.value || null) : null);
  const noteEl = document.getElementById('detail-note');
  const note = ((noteEl && noteEl.value) || '').trim().slice(0, 280);

  if (!newEan || newEan.length < 5) {
    leaveAfterSave = null;
    showToast('Inserisci un EAN valido (solo numeri)');
    if (eanInput) eanInput.focus();
    return;
  }

  if (!noExpiry && signaled && !signaledDate) {
    leaveAfterSave = null;
    showToast('Inserisci la Data di segnalazione (obbligatoria)');
    if (signaledDateInput) signaledDateInput.focus();
    return;
  }

  // EAN cambiato: controlla duplicati
  if (newEan !== oldEan) {
    const exists = products.find(p => p.ean === newEan);
    if (exists) {
      leaveAfterSave = null;
      showToast('Questo EAN è già usato da: ' + (exists.name || newEan));
      return;
    }
  }

  currentProduct.noExpiry = noExpiry;
  currentProduct.expiry = expiry;
  currentProduct.signaled = signaled;
  currentProduct.signaledDate = signaled ? signaledDate : null;
  currentProduct.note = note;
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
    await logProductChanges(before, {
      ean: newEan,
      expiry: expiry,
      signaled: signaled,
      signaledDate: signaled ? signaledDate : null,
      noExpiry: noExpiry,
      note: note
    });
    showToast('Cloud non disponibile — salvato solo su questo telefono', 'warn');
    updateDashboard();
    return;
  }

  showToast('Salvataggio su cloud in corso...', 'info');
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
    showToast(newEan !== oldEan ? 'EAN aggiornato e salvato' : 'Salvato e sincronizzato', 'success');
    await logProductChanges(before, {
      ean: newEan,
      expiry: expiry,
      signaled: signaled,
      signaledDate: signaled ? signaledDate : null,
      noExpiry: noExpiry,
      note: note
    });
    await saveNoteToCloud(newEan, note, oldEan);
  } else {
    showToast('Salvato in locale — il collega non lo vede ancora', 'warn');
  }
  updateDashboard();
  const dest = leaveAfterSave || 'scanner';
  leaveAfterSave = null;
  detailSnapshot = null;
  skipDetailDirty = true;
  showPage(dest);
  skipDetailDirty = false;
  if (dest === 'scanner') detailReturnPage = 'dashboard';
  else runPageEnter(dest);
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
    try {
      await supabase.from('prodotti_note').delete().eq('ean', ean);
    } catch (e) {}
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
  detailSnapshot = null;
  skipDetailDirty = true;
  showToast('Prodotto eliminato');
  updateDashboard();
  showPage('dashboard');
  skipDetailDirty = false;
}

// ---------- Scanner ----------
function unlockScanFeedback() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!scanAudioCtx) scanAudioCtx = new AC();
    if (scanAudioCtx.state === 'suspended') scanAudioCtx.resume();
  } catch (e) {}
}

function playScanBeep(ok) {
  if (!isScanBeepOn()) return;
  try {
    unlockScanFeedback();
    if (!scanAudioCtx) return;
    const ctx = scanAudioCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.value = ok ? 880 : 220;
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.14, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + (ok ? 0.13 : 0.22));
    osc.start(now);
    osc.stop(now + (ok ? 0.15 : 0.26));
    if (!ok) {
      const osc2 = ctx.createOscillator();
      const g2 = ctx.createGain();
      osc2.connect(g2);
      g2.connect(ctx.destination);
      osc2.type = 'sine';
      osc2.frequency.value = 165;
      g2.gain.setValueAtTime(0.0001, now + 0.12);
      g2.gain.exponentialRampToValueAtTime(0.12, now + 0.14);
      g2.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);
      osc2.start(now + 0.12);
      osc2.stop(now + 0.34);
    }
  } catch (e) {}
}

function hapticScan(ok) {
  try {
    if (typeof navigator.vibrate === 'function') {
      navigator.vibrate(ok ? [35, 40, 55] : [90, 50, 90, 50, 120]);
    }
  } catch (e) {}
}

function flashScanner(ok) {
  const box = document.querySelector('.scanner-box') || document.getElementById('reader');
  if (!box) return;
  box.classList.remove('scan-flash-ok', 'scan-flash-err');
  void box.offsetWidth;
  box.classList.add(ok ? 'scan-flash-ok' : 'scan-flash-err');
  setTimeout(() => box.classList.remove('scan-flash-ok', 'scan-flash-err'), 650);
}

function scanFeedback(ok, ean) {
  hapticScan(ok);
  playScanBeep(ok);
  flashScanner(ok);
  if (ok) {
    const tail = String(ean || '').slice(-6);
    showToast(tail ? ('Codice letto · ' + tail) : 'Codice letto', 'success');
  } else {
    showToast('Prodotto non trovato', 'error');
  }
}

function scanQrboxSize(vw, vh) {
  const width = Math.max(240, Math.floor(vw * 0.92));
  const height = Math.max(80, Math.min(Math.floor(vh * 0.28), 160));
  return { width: width, height: height };
}

function scanFormats() {
  if (typeof Html5QrcodeSupportedFormats === 'undefined') return null;
  const F = Html5QrcodeSupportedFormats;
  return [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128];
}

async function pickBackCameraId() {
  try {
    const cams = await Html5Qrcode.getCameras();
    if (!cams || !cams.length) return null;
    const back = cams.find(c => /back|rear|environment|dietro|indietro|trasera/i.test(c.label || ''));
    return (back || cams[cams.length - 1] || cams[0]).id;
  } catch (e) {
    return null;
  }
}

async function boostScanTrack() {
  const track = getScanVideoTrack();
  if (!track || typeof track.getCapabilities !== 'function') return;
  let cap = {};
  try { cap = track.getCapabilities() || {}; } catch (e) { return; }
  const cons = {};
  if (cap.width) cons.width = { ideal: Math.min(1920, cap.width.max || 1920) };
  if (cap.height) cons.height = { ideal: Math.min(1080, cap.height.max || 1080) };
  if (cap.frameRate) cons.frameRate = { ideal: Math.min(30, cap.frameRate.max || 30) };
  const advanced = [];
  if (cap.focusMode && cap.focusMode.indexOf('continuous') >= 0) advanced.push({ focusMode: 'continuous' });
  if (cap.zoom) {
    const min = cap.zoom.min || 1;
    const max = cap.zoom.max || 1;
    advanced.push({ zoom: Math.min(max, Math.max(min, 1.5)) });
  }
  if (advanced.length) cons.advanced = advanced;
  if (!Object.keys(cons).length) return;
  try { await track.applyConstraints(cons); } catch (e) {}
}

async function startScanner() {
  if (isScanning) return;
  unlockScanFeedback();
  const reader = document.getElementById('reader');
  reader.innerHTML = '';
  const ctorOpts = {
    verbose: false,
    experimentalFeatures: { useBarCodeDetectorIfSupported: true }
  };
  const formats = scanFormats();
  if (formats) ctorOpts.formatsToSupport = formats;

  const qrbox = scanQrboxSize;
  const cameraId = await pickBackCameraId();
  const attempts = [];
  if (cameraId) {
    attempts.push({
      cam: cameraId,
      cfg: {
        fps: 18,
        qrbox: qrbox,
        disableFlip: true,
        aspectRatio: 1.777,
        videoConstraints: {
          deviceId: { exact: cameraId },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 }
        }
      }
    });
    attempts.push({ cam: cameraId, cfg: { fps: 16, qrbox: qrbox, disableFlip: true } });
  }
  attempts.push({
    cam: { facingMode: 'environment' },
    cfg: {
      fps: 18,
      qrbox: qrbox,
      disableFlip: true,
      videoConstraints: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      }
    }
  });
  attempts.push({
    cam: { facingMode: 'environment' },
    cfg: { fps: 12, qrbox: { width: 280, height: 120 }, disableFlip: true }
  });

  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    try {
      html5QrCode = new Html5Qrcode('reader', ctorOpts);
      await html5QrCode.start(attempts[i].cam, attempts[i].cfg, onScanSuccess, () => {});
      isScanning = true;
      document.getElementById('btn-stop-scanner').classList.remove('hidden');
      const bs = document.getElementById('btn-start-scanner');
      if (bs) bs.classList.add('hidden');
      torchOn = false;
      setTimeout(async () => {
        await boostScanTrack();
        const hasTorch = await detectTorch();
        updateTorchButton(hasTorch);
      }, 500);
      return;
    } catch (err) {
      lastErr = err;
      try { if (html5QrCode) await html5QrCode.stop(); } catch (e) {}
      html5QrCode = null;
      reader.innerHTML = '';
    }
  }
  console.error(lastErr);
  showToast('Impossibile avviare la fotocamera. Controlla i permessi.', 'error');
}

async function stopScanner() {
  if (html5QrCode && isScanning) {
    if (torchOn) {
      try { await setTorch(false); } catch (e) {}
    }
    try { await html5QrCode.stop(); } catch (e) {}
    isScanning = false;
    document.getElementById('btn-stop-scanner').classList.add('hidden');
    const btnStart = document.getElementById('btn-start-scanner');
    if (btnStart) btnStart.classList.remove('hidden');
    updateTorchButton(false);
    torchOn = false;
  }
}

async function detectTorch() {
  try {
    if (html5QrCode && typeof html5QrCode.getRunningTrackCapabilities === 'function') {
      const cap = html5QrCode.getRunningTrackCapabilities();
      if (cap && cap.torch) return true;
    }
  } catch (e) {}
  try {
    const video = document.querySelector('#reader video');
    const track = video && video.srcObject && video.srcObject.getVideoTracks()[0];
    const cap = track && track.getCapabilities && track.getCapabilities();
    if (cap && cap.torch) return true;
  } catch (e) {}
  return false;
}

function getScanVideoTrack() {
  try {
    const video = document.querySelector('#reader video');
    return video && video.srcObject ? video.srcObject.getVideoTracks()[0] : null;
  } catch (e) {
    return null;
  }
}

async function setTorch(on) {
  try {
    if (html5QrCode && typeof html5QrCode.applyVideoConstraints === 'function') {
      await html5QrCode.applyVideoConstraints({ advanced: [{ torch: !!on }] });
      return true;
    }
  } catch (e) {
    console.warn('torch html5', e);
  }
  try {
    const track = getScanVideoTrack();
    if (track) {
      await track.applyConstraints({ advanced: [{ torch: !!on }] });
      return true;
    }
  } catch (e) {
    console.warn('torch track', e);
  }
  return false;
}

function updateTorchButton(available) {
  const b = document.getElementById('btn-torch');
  if (!b) return;
  if (!available || !isScanning) {
    b.classList.add('hidden');
    b.classList.remove('is-on');
    b.textContent = 'Torcia';
    return;
  }
  b.classList.remove('hidden');
  b.classList.toggle('is-on', torchOn);
  b.textContent = torchOn ? 'Torcia accesa' : 'Torcia';
}

async function toggleTorch() {
  if (!isScanning) return;
  const next = !torchOn;
  const ok = await setTorch(next);
  if (!ok) {
    showToast('Torcia non disponibile su questo telefono', 'warn');
    updateTorchButton(false);
    return;
  }
  torchOn = next;
  updateTorchButton(true);
}

function onScanSuccess(decodedText) {
  const ean = String(decodedText || '').replace(/\D/g, '') || String(decodedText || '');
  const now = Date.now();
  if (!ean) return;
  if (ean === lastScanCode && now - lastScanAt < 1600) return;
  lastScanCode = ean;
  lastScanAt = now;

  const product = products.find(p => p.ean === ean || p.ean === decodedText);
  scanFeedback(!!product, ean);
  stopScanner();
  if (product) {
    setTimeout(() => openProduct(product.ean, 'scanner'), 280);
  } else {
    const box = document.getElementById('scan-result');
    if (!box) return;
    box.classList.remove('hidden');
    box.innerHTML = `
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
    if (!silent) showToast('Sincronizzazione in corso...', 'info');
    await loadEanRinomin();
    await loadCustomProducts();
    await loadScadenzeFromCloud();
    await loadNotesFromCloud();
    applyAccessoriesNoExpiry();
    await loadBacheca();
    await loadTasks();
    await loadTurni();
    await refreshMissione();
    await loadNonInNegozio();
    await loadConsegne();
    updateDashboard();
    updateMyTasksAlert();
    markSync(true);
    if (!silent) showToast('Sincronizzazione completata', 'success');
  } catch (e) {
    console.error('Sync error:', e);
    markSync(false);
    if (!silent) showToast('Errore sincronizzazione', 'error');
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
  const sqlBtn = document.getElementById('btn-copy-prova-sql');
  if (sqlBtn) sqlBtn.classList.toggle('hidden', currentOperator !== 'Santoemma');
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
    el.innerHTML = emptyStateHtml(
      'Bacheca vuota',
      'Nessun messaggio per il team. Scrivi il primo avviso.',
      'new-bacheca',
      'Scrivi un messaggio'
    );
    wireEmptyActions(el);
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
    mergeTaskDueLocal();
    renderTasks();
    updateMyTasksAlert();
  } catch (e) {
    console.error(e);
  }
}

function readTaskDueLocal() {
  try {
    const o = JSON.parse(localStorage.getItem('petstore_task_due') || '{}');
    return o && typeof o === 'object' ? o : {};
  } catch (e) { return {}; }
}

function writeTaskDueLocal() {
  try { localStorage.setItem('petstore_task_due', JSON.stringify(taskDueLocal)); } catch (e) {}
}

function mergeTaskDueLocal() {
  taskDueLocal = readTaskDueLocal();
  tasksList.forEach(t => {
    if (!t.due_date && taskDueLocal[t.id]) t.due_date = taskDueLocal[t.id];
  });
}

function taskDueStr(t) {
  const d = t && (t.due_date || (t.id && taskDueLocal[t.id]));
  return d ? String(d).slice(0, 10) : '';
}

function taskDueKind(t) {
  if (!t || t.stato === 'fatto') return '';
  const d = taskDueStr(t);
  if (!d) return '';
  const today = todayStr();
  if (d < today) return 'overdue';
  if (d === today) return 'today';
  return 'later';
}

function formatTaskDue(t) {
  const kind = taskDueKind(t);
  const d = taskDueStr(t);
  if (kind === 'overdue') return 'Scaduta il ' + formatExportDate(d);
  if (kind === 'today') return 'Da fare oggi';
  if (d) return 'Entro ' + formatExportDate(d);
  return '';
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
  const overdue = mine.filter(t => taskDueKind(t) === 'overdue');
  const todayDue = mine.filter(t => taskDueKind(t) === 'today');
  el.classList.remove('hidden');
  let extra = '';
  if (overdue.length) extra += ` · <strong>${overdue.length}</strong> in ritardo`;
  if (todayDue.length) extra += ` · <strong>${todayDue.length}</strong> per oggi`;
  el.innerHTML = `Hai <strong>${mine.length}</strong> task da fare` +
    (alte ? ` (di cui <strong>${alte}</strong> ad alta priorità)` : '') +
    extra +
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

  list.sort((a, b) => {
    if (a.stato === 'fatto' && b.stato !== 'fatto') return 1;
    if (b.stato === 'fatto' && a.stato !== 'fatto') return -1;
    const ka = taskDueKind(a);
    const kb = taskDueKind(b);
    const rank = { overdue: 0, today: 1, later: 2, '': 3 };
    const ra = rank[ka] != null ? rank[ka] : 3;
    const rb = rank[kb] != null ? rank[kb] : 3;
    if (ra !== rb) return ra - rb;
    const da = taskDueStr(a);
    const db = taskDueStr(b);
    if (da && db && da !== db) return da.localeCompare(db);
    if (a.priorita === 'alta' && b.priorita !== 'alta') return -1;
    if (b.priorita === 'alta' && a.priorita !== 'alta') return 1;
    return new Date(b.created_at || 0) - new Date(a.created_at || 0);
  });

  if (!list.length) {
    const emptyTask = {
      miei: ['Nessun task per te', 'Non hai task aperti assegnati. Puoi crearne uno nuovo per il reparto.', 'new-task', 'Nuovo task'],
      aperti: ['Nessun task aperto', 'Tutti i task risultano completati, oppure non ne è stato creato nessuno.', 'new-task', 'Nuovo task'],
      fatti: ['Nessun task completato', 'Quando un task viene chiuso, resta visibile qui.', '', ''],
      tutti: ['Nessun task', 'Crea il primo task e assegnalo a uno o più operatori.', 'new-task', 'Nuovo task']
    };
    const cfg = emptyTask[taskFilter] || emptyTask.tutti;
    el.innerHTML = emptyStateHtml(cfg[0], cfg[1], cfg[2] || null, cfg[3]);
    wireEmptyActions(el);
    return;
  }

  el.innerHTML = list.map(t => {
    const resp = (t.responsabili || []).join(', ');
    const date = t.created_at ? new Date(t.created_at).toLocaleDateString('it-IT') : '';
    const isDone = t.stato === 'fatto';
    const dueKind = taskDueKind(t);
    const dueLab = formatTaskDue(t);
    const cls = (t.priorita === 'alta' ? 'alta ' : '') + (isDone ? 'fatto' : '') + (dueKind === 'overdue' ? ' overdue' : '') + (dueKind === 'today' ? ' due-today' : '');
    const badge = isDone
      ? '<span class="task-badge fatto">Fatto</span>'
      : (dueKind === 'overdue'
        ? '<span class="task-badge overdue">In ritardo</span>'
        : (dueKind === 'today'
          ? '<span class="task-badge today">Oggi</span>'
          : (t.priorita === 'alta'
            ? '<span class="task-badge alta">Alta</span>'
            : '<span class="task-badge normale">Normale</span>')));
    return `<div class="task-card ${cls}" data-id="${t.id}">
      <div class="product-card-top">
        <div class="task-card-title">${escapeHtml(t.titolo)}</div>
        ${badge}
      </div>
      ${t.descrizione ? `<div class="task-card-desc">${escapeHtml(t.descrizione)}</div>` : ''}
      <div class="task-card-meta">
        ${resp ? `<span class="product-supplier">${escapeHtml(resp)}</span>` : ''}
        ${dueLab ? `<span class="task-due">${escapeHtml(dueLab)}</span>` : ''}
        ${t.created_by ? `<span>${escapeHtml(t.created_by)}</span>` : ''}
        ${date ? `<span>${date}</span>` : ''}
      </div>
      ${!isDone
        ? `<button class="btn btn-primary mission-check-btn btn-complete-task" data-id="${t.id}">Completa</button>
           <button type="button" class="btn btn-secondary btn-large btn-edit-task" data-id="${t.id}" style="margin-top:8px;">Modifica</button>
           <button type="button" class="btn-text-back btn-delete-task" data-id="${t.id}">Elimina</button>`
        : `<button type="button" class="btn-text-back btn-delete-task" data-id="${t.id}">Elimina</button>`}
    </div>`;
  }).join('');

  el.querySelectorAll('.btn-complete-task').forEach(btn => {
    btn.onclick = () => completeTask(btn.dataset.id);
  });
  el.querySelectorAll('.btn-edit-task').forEach(btn => {
    btn.onclick = () => openTaskEdit(btn.dataset.id);
  });
  el.querySelectorAll('.btn-delete-task').forEach(btn => {
    btn.onclick = () => deleteTask(btn.dataset.id);
  });
}

function openTaskForm() {
  fillTaskForm(null);
}

function openTaskEdit(id) {
  const t = tasksList.find(x => String(x.id) === String(id));
  if (!t) return;
  fillTaskForm(t);
}

function fillTaskForm(t) {
  editingTaskId = t ? t.id : null;
  document.getElementById('task-form-title').textContent = t ? 'Modifica task' : 'Nuovo task';
  const saveBtn = document.getElementById('btn-save-task');
  if (saveBtn) saveBtn.textContent = t ? 'Salva modifiche' : 'Salva task';
  document.getElementById('task-titolo').value = t ? (t.titolo || '') : '';
  document.getElementById('task-descrizione').value = t ? (t.descrizione || '') : '';
  document.getElementById('task-priorita').value = t && t.priorita === 'alta' ? 'alta' : 'normale';
  const dueEl = document.getElementById('task-due-date');
  if (dueEl) dueEl.value = t ? taskDueStr(t) : '';
  document.querySelectorAll('#task-responsabili input').forEach(cb => {
    cb.checked = t ? (t.responsabili || []).indexOf(cb.value) >= 0 : (cb.value === currentOperator);
  });
  document.getElementById('task-form-overlay').classList.remove('hidden');
}

function closeTaskForm() {
  document.getElementById('task-form-overlay').classList.add('hidden');
  editingTaskId = null;
  const saveBtn = document.getElementById('btn-save-task');
  if (saveBtn) saveBtn.textContent = 'Salva task';
}

async function saveTask() {
  const titolo = (document.getElementById('task-titolo').value || '').trim();
  const descrizione = (document.getElementById('task-descrizione').value || '').trim();
  const priorita = document.getElementById('task-priorita').value;
  const dueDate = ((document.getElementById('task-due-date') || {}).value || '').slice(0, 10);
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
  if (dueDate && !taskDueColumnMissing) payload.due_date = dueDate;

  if (editingTaskId) {
    const update = {
      titolo,
      descrizione: descrizione || null,
      priorita,
      responsabili
    };
    if (!taskDueColumnMissing) update.due_date = dueDate || null;
    let { error } = await supabase.from('tasks').update(update).eq('id', editingTaskId);
    if (error && /due_date|schema cache|42703/i.test((error.message || '') + (error.code || ''))) {
      taskDueColumnMissing = true;
      delete update.due_date;
      const retry = await supabase.from('tasks').update(update).eq('id', editingTaskId);
      error = retry.error;
    }
    if (error) {
      showToast('Errore: ' + error.message);
      return;
    }
    if (dueDate) taskDueLocal[editingTaskId] = dueDate;
    else delete taskDueLocal[editingTaskId];
    writeTaskDueLocal();
    showToast('Task aggiornato', 'success');
    closeTaskForm();
    await loadTasks();
    return;
  }

  let { error } = await supabase.from('tasks').insert(payload);
  if (error && /due_date|schema cache|42703/i.test((error.message || '') + (error.code || ''))) {
    taskDueColumnMissing = true;
    delete payload.due_date;
    const retry = await supabase.from('tasks').insert(payload);
    error = retry.error;
    if (!error && dueDate) {
      showToast('Task creato. Per la data: Impostazioni → Copia SQL tabelle extra', 'warn');
    }
  }
  if (error) {
    showToast('Errore: ' + error.message);
    console.error(error);
    return;
  }
  if (dueDate) {
    const { data } = await supabase.from('tasks').select('id').eq('titolo', titolo).order('created_at', { ascending: false }).limit(1);
    const id = data && data[0] && data[0].id;
    if (id) {
      taskDueLocal[id] = dueDate;
      writeTaskDueLocal();
    }
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
    el.innerHTML = emptyStateHtml(
      'Nessuna settimana in archivio',
      'Carica la foto del foglio turni. Resta salvata e si può rivedere nello storico.',
      'new-settimana',
      'Carica settimana'
    );
    wireEmptyActions(el);
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
    el.innerHTML = emptyStateHtml(
      'Nessuna settimana precedente',
      'Quando carichi un nuovo foglio, le settimane passate restano qui nello storico.',
      'new-settimana',
      'Carica settimana'
    );
    wireEmptyActions(el);
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

function packedCell(data, op, day) {
  return (data && data[op] && data[op][String(day)]) || '';
}

function packedShop(data, op, day) {
  const n = data && data._negozi && data._negozi[op] && data._negozi[op][String(day)];
  if (typeof n === 'string' && n) return n;
  const c = packedCell(data, op, day);
  if (isBagheriaCode(c)) return 'Bagheria';
  if (!c || c === 'R' || c === 'F' || c === 'M') return '';
  return 'La Malfa';
}

function packedSlot2(data, op, day) {
  return (data && data._slot2 && data._slot2[op] && data._slot2[op][String(day)]) || null;
}

function todayProvaDayIdx(d) {
  const day = (d || new Date()).getDay();
  return day === 0 ? 6 : day - 1;
}

function provaLineLabel(code, shop) {
  if (!code) return '—';
  if (code === 'R') return 'Riposo';
  if (code === 'F') return 'Ferie';
  if (code === 'M') return 'Malattia';
  const lab = PROVA_LABEL[code] || code;
  return shop ? (lab + ' · ' + shop) : lab;
}

async function loadOggiTurniDash() {
  const el = document.getElementById('turni-dash');
  if (!el) return;
  const week = provaMondayStr(new Date());
  const day = todayProvaDayIdx();
  let data = null;
  if (provaWeekStart === week && provaCelle && OPERATORS.some(op => provaCell(op, day))) {
    data = provaPackCelle();
  } else if (supabase) {
    try {
      const { data: rows, error } = await supabase
        .from('turni_prova')
        .select('celle')
        .eq('settimana_inizio', week)
        .limit(1);
      if (!error && rows && rows[0]) data = rows[0].celle;
    } catch (e) {}
  }
  const has = data && OPERATORS.some(op => packedCell(data, op, day) || (packedSlot2(data, op, day) && packedSlot2(data, op, day).code));
  el.className = 'turni-oggi-dash home-alert';
  el.classList.remove('hidden');
  const dayLab = PROVA_DAYS[day] + ' ' + new Date().toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
  if (!has) {
    el.innerHTML = '<div class="consegne-dash-title">Chi è in turno oggi</div><div class="consegne-dash-sub">Nessun turno 2.0 salvato per ' + escapeHtml(dayLab) + '. Tocca per aprire Turni 2.0.</div>';
  } else {
    let html = '<div class="consegne-dash-title">Chi è in turno · ' + escapeHtml(dayLab) + '</div>';
    OPERATORS.forEach(op => {
      const c = packedCell(data, op, day);
      const shop = packedShop(data, op, day);
      const s2 = packedSlot2(data, op, day);
      const line = provaLineLabel(c, shop);
      const line2 = s2 && s2.code ? provaLineLabel(s2.code, s2.shop) : '';
      const cls = (!c || c === 'R') ? 'is-off' : (c === 'F' ? 'is-ferie' : (c === 'M' ? 'is-malattia' : 'is-on'));
      html += '<div class="turni-oggi-row ' + cls + '"><span class="turni-oggi-name">' + escapeHtml(op) + '</span><span class="turni-oggi-shift">' + escapeHtml(line) + (line2 ? '<small>' + escapeHtml(line2) + '</small>' : '') + '</span></div>';
    });
    el.innerHTML = html;
  }
  el.onclick = () => {
    provaWeekStart = week;
    if (!showPage('turni-prova')) return;
    runPageEnter('turni-prova');
  };
}

function updateTurniDash() {
  loadOggiTurniDash();
}

const PROVA_FASCE = ['', 'A', 'C', 'S', 'S6', 'S7', '7C', '6A', '6C', '6M', '5C', '4A', '4C', '3C', 'B', 'B44', 'B4A', 'B4C', 'DM', 'DS', 'R', 'F', 'M'];
const PROVA_LABEL = {
  '': '·',
  A: '9-17',
  C: '12-20',
  S: '4+4',
  S6: '3+3',
  S7: '9-12/16-20',
  '7C': '11-20',
  '6A': '9-15',
  '6C': '14-20',
  '6M': '10-16',
  '5C': '15-20',
  '4A': '9-13',
  '4C': '16-20',
  '3C': '17-20',
  B: 'Bagh.',
  B44: 'Bag 4+4',
  B4A: 'Bag 9-13',
  B4C: 'Bag 16-20',
  DM: '9-15',
  DS: '14-20',
  R: 'R',
  F: 'Ferie',
  M: 'Mal.'
};
const PROVA_TITLE = {
  '': 'Vuoto',
  A: 'Intero 09:00–17:00 (8h, pausa inclusa)',
  C: 'Intero 12:00–20:00 (8h, pausa inclusa)',
  S: 'Spezzato 09:00–13:00 e 16:00–20:00 (8h)',
  S6: 'Spezzato 09:00–12:00 e 17:00–20:00 (6h)',
  S7: 'Spezzato 09:00–12:00 e 16:00–20:00 (7h)',
  '7C': '11:00–20:00 (9h)',
  '6A': '09:00–15:00 (6h)',
  '6C': '14:00–20:00 (6h)',
  '6M': '10:00–16:00 (6h)',
  '5C': '15:00–20:00 (5h)',
  '4A': '09:00–13:00 (4h)',
  '4C': '16:00–20:00 (4h)',
  '3C': '17:00–20:00 (3h)',
  B: 'Bagheria giornata (8h)',
  B44: 'Bagheria 4+4 (09-13 e 16-20, 8h)',
  B4A: 'Bagheria 09-13 (4h)',
  B4C: 'Bagheria 16-20 (4h)',
  DM: '09:00–15:00 (6h)',
  DS: '14:00–20:00 (6h)',
  R: 'Riposo',
  F: 'Ferie (8h, non in negozio)',
  M: 'Malattia (8h, non in negozio)'
};
const PROVA_HOURS = { '': 0, A: 8, C: 8, S: 8, S6: 6, S7: 7, '7C': 9, '6A': 6, '6C': 6, '6M': 6, '5C': 5, '4A': 4, '4C': 4, '3C': 3, B: 8, B44: 8, B4A: 4, B4C: 4, DM: 6, DS: 6, R: 0, F: 8, M: 8 };
const PROVA_SPANS = {
  A: [[9, 17]],
  C: [[12, 20]],
  S: [[9, 13], [16, 20]],
  S6: [[9, 12], [17, 20]],
  S7: [[9, 12], [16, 20]],
  '7C': [[11, 20]],
  '6A': [[9, 15]],
  '6C': [[14, 20]],
  '6M': [[10, 16]],
  '5C': [[15, 20]],
  '4A': [[9, 13]],
  '4C': [[16, 20]],
  '3C': [[17, 20]],
  DM: [[9, 15]],
  DS: [[14, 20]]
};
const PROVA_DAYS = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'];
const PUNTI_VENDITA = ['La Malfa', 'Rizzo', 'San Lorenzo', 'Bagheria'];
const NEGOZIO_CLASS = {
  'La Malfa': 'pv-malfa',
  'Rizzo': 'pv-rizzo',
  'San Lorenzo': 'pv-lorenzo',
  'Bagheria': 'pv-bagheria'
};
let provaWeekStart = null;
let provaCelle = {};
let provaNegozi = {};
let provaVincoli = {};
let provaVincoliNegozi = {};
let provaVincoliBagheria = {};
let provaSlot2 = {};
let provaVincoliSlot2 = {};
let provaLastBozza = null;
let provaTableMissing = false;
let provaSwapArmed = false;
let provaSwapA = null;
let provaUnlockedWeek = null;

function provaMondayStr(d) {
  return toDateStr(mondayOf(d || new Date()));
}

function provaSundayPassed() {
  if (!provaWeekStart) return false;
  const sun = sundayOf(parseDate(provaWeekStart));
  sun.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return sun.getTime() < today.getTime();
}

function provaIsLocked() {
  return provaSundayPassed() && provaUnlockedWeek !== provaWeekStart;
}

function provaGuardLocked(action) {
  if (!provaIsLocked()) return false;
  showToast('Settimana chiusa: solo consultazione' + (currentOperator === 'Santoemma' ? '. Puoi sbloccare per una correzione.' : '.'), 'warn');
  return true;
}

function unlockProvaWeek() {
  if (currentOperator !== 'Santoemma') {
    showToast('Solo Santoemma può sbloccare una settimana chiusa', 'warn');
    return;
  }
  if (!provaSundayPassed()) return;
  provaUnlockedWeek = provaWeekStart;
  renderTurniProva();
  showToast('Settimana sbloccata per correzione. Poi Salva.', 'info');
}

function shiftProvaWeek(days) {
  const cur = parseDate(provaWeekStart || provaMondayStr());
  cur.setDate(cur.getDate() + days);
  provaWeekStart = toDateStr(mondayOf(cur));
  loadTurniProva();
}

function syncProvaWeekInputs() {
  const v = provaWeekStart || provaMondayStr();
  const a = document.getElementById('prova-week-date');
  const b = document.getElementById('prova-vincoli-week');
  if (a) a.value = v;
  if (b) b.value = v;
}

function setProvaWeekFromDate(dateStr, load) {
  const d = parseDate(dateStr);
  if (!d || isNaN(d.getTime())) return;
  provaWeekStart = toDateStr(mondayOf(d));
  syncProvaWeekInputs();
  if (load) loadTurniProva();
}

function provaCell(op, dayIdx) {
  const row = provaCelle[op] || {};
  return row[String(dayIdx)] || '';
}

function setProvaCell(op, dayIdx, val) {
  if (!provaCelle[op]) provaCelle[op] = {};
  if (!val) delete provaCelle[op][String(dayIdx)];
  else provaCelle[op][String(dayIdx)] = val;
}

function provaNegozio(op, dayIdx) {
  const n = provaNegozi[op] && provaNegozi[op][String(dayIdx)];
  if (n && typeof n === 'object') return n.a || n.b || '';
  if (typeof n === 'string' && n) return n;
  const c = provaCell(op, dayIdx);
  if (isBagheriaCode(c)) return 'Bagheria';
  if (!c || c === 'R' || c === 'F' || c === 'M') return '';
  return 'La Malfa';
}

function setProvaNegozio(op, dayIdx, val) {
  if (!provaNegozi[op]) provaNegozi[op] = {};
  if (!val) delete provaNegozi[op][String(dayIdx)];
  else provaNegozi[op][String(dayIdx)] = val;
}

function vNegozio(op, day) {
  const n = provaVincoliNegozi[op] && provaVincoliNegozi[op][String(day)];
  if (n && typeof n === 'object') return n.a || '';
  return n || '';
}

function provaSecond(op, day) {
  return (provaSlot2[op] && provaSlot2[op][String(day)]) || null;
}

function setProvaSecond(op, day, code, shop) {
  if (!provaSlot2[op]) provaSlot2[op] = {};
  if (!code) {
    delete provaSlot2[op][String(day)];
    return;
  }
  provaSlot2[op][String(day)] = { code: code, shop: shop || 'La Malfa' };
}

function provaSlot2Options() {
  return [
    ['', '— 2° orario'],
    ['4A', '09-13 (4h)'],
    ['4C', '16-20 (4h)'],
    ['3C', '17-20 (3h)'],
    ['5C', '15-20 (5h)'],
    ['6A', '09-15 (6h)'],
    ['6C', '14-20 (6h)'],
    ['6M', '10-16 (6h)']
  ];
}

function provaDayHours(op, day) {
  return (PROVA_HOURS[provaCell(op, day)] || 0) + (PROVA_HOURS[(provaSecond(op, day) || {}).code] || 0);
}

function provaIsWorkCode(c) {
  return !!(c && c !== 'R' && c !== 'F' && c !== 'M');
}

function provaAtMain(op, day, code) {
  const c = code !== undefined ? code : provaCell(op, day);
  if (provaIsWorkCode(c) && !isBagheriaCode(c)) {
    const n = (typeof (provaNegozi[op] && provaNegozi[op][String(day)]) === 'string'
      ? provaNegozi[op][String(day)]
      : vNegozio(op, day)) || 'La Malfa';
    if (n === 'La Malfa') return true;
  }
  const s2 = provaSecond(op, day);
  return !!(s2 && s2.shop === 'La Malfa' && provaIsWorkCode(s2.code));
}

function provaAtMainHour(op, day, hour, codeOverride) {
  const c = codeOverride !== undefined ? codeOverride : provaCell(op, day);
  if (provaIsWorkCode(c) && !isBagheriaCode(c) && provaPresent(c, hour)) {
    const n = (provaNegozi[op] && provaNegozi[op][String(day)]) || vNegozio(op, day) || 'La Malfa';
    const shop = typeof n === 'string' ? n : (n && n.a) || 'La Malfa';
    if (shop === 'La Malfa') return true;
  }
  const s2 = provaSecond(op, day);
  if (s2 && s2.shop === 'La Malfa' && provaPresent(s2.code, hour)) return true;
  return false;
}

function provaPvClass(op, day) {
  const c = provaCell(op, day);
  if (c === 'F') return 'pv-ferie';
  if (c === 'M') return 'pv-malattia';
  if (!c || c === 'R') return 'pv-riposo';
  return NEGOZIO_CLASS[provaNegozio(op, day)] || 'pv-malfa';
}

function provaPackCelle() {
  const out = {};
  OPERATORS.forEach(op => { out[op] = provaCelle[op] || {}; });
  out._negozi = provaNegozi;
  out._slot2 = provaSlot2;
  if (provaLastBozza) out._bozza = provaLastBozza;
  return out;
}

function provaUnpackCelle(data) {
  provaCelle = {};
  provaNegozi = {};
  provaSlot2 = {};
  provaLastBozza = null;
  if (!data || typeof data !== 'object') return;
  if (data._negozi && typeof data._negozi === 'object') provaNegozi = data._negozi;
  if (data._slot2 && typeof data._slot2 === 'object') provaSlot2 = data._slot2;
  if (data._bozza && typeof data._bozza === 'object') provaLastBozza = data._bozza;
  OPERATORS.forEach(op => { provaCelle[op] = data[op] && typeof data[op] === 'object' ? data[op] : {}; });
}

function provaSyncNegozi() {
  OPERATORS.forEach(op => {
    for (let d = 0; d < 7; d++) {
      const c = provaCell(op, d);
      if (!provaIsWorkCode(c)) { setProvaNegozio(op, d, ''); continue; }
      if (isBagheriaCode(c)) { setProvaNegozio(op, d, 'Bagheria'); continue; }
      const vn = vNegozio(op, d);
      const cur = provaNegozi[op] && provaNegozi[op][String(d)];
      if (vn) setProvaNegozio(op, d, vn);
      else if (!cur) setProvaNegozio(op, d, 'La Malfa');
    }
  });
}

function cycleProvaFascia(cur) {
  const i = PROVA_FASCE.indexOf(cur);
  return PROVA_FASCE[(i + 1) % PROVA_FASCE.length];
}

const PROVA_BAGHERIA_OP = 'Sorrentino';

function isBagheriaCode(c) {
  return c === 'B' || c === 'B44' || c === 'B4A' || c === 'B4C';
}

function codeToBagheriaRow(code) {
  if (code === '4A' || code === 'B4A') return 'B4A';
  if (code === '4C' || code === 'B4C') return 'B4C';
  if (code === 'B44' || code === 'B' || code === 'S' || code === 'S6' || code === 'A' || code === 'C' || code === '7C' || code === '6A' || code === '6C') return 'B44';
  if (provaIsWorkCode(code)) return 'B44';
  return 'L';
}

function provaOpAtBagheria(day) {
  return OPERATORS.find(op => {
    if (isBagheriaCode(provaCell(op, day))) return true;
    if (provaNegozio(op, day) === 'Bagheria') return true;
    const s2 = provaSecond(op, day);
    return !!(s2 && s2.shop === 'Bagheria');
  }) || null;
}

function provaBagheriaOptions() {
  return [
    ['L', 'Libero'],
    ['B44', '4+4 (8h)'],
    ['B4A', '09-13 (4h)'],
    ['B4C', '16-20 (4h)']
  ];
}

function provaBagheriaValue(day) {
  const who = provaOpAtBagheria(day);
  if (!who) return 'L';
  const s2 = provaSecond(who, day);
  if (s2 && s2.shop === 'Bagheria') return codeToBagheriaRow(s2.code);
  const c = provaCell(who, day);
  if (c === 'B') return 'B44';
  if (isBagheriaCode(c)) return c;
  return codeToBagheriaRow(c);
}

function applyBagheriaDay(day, val) {
  const current = provaOpAtBagheria(day);
  const op = current || PROVA_BAGHERIA_OP;
  if (!val || val === 'L') {
    if (isBagheriaCode(provaCell(op, day)) || provaNegozio(op, day) === 'Bagheria') {
      if (isBagheriaCode(provaCell(op, day))) setProvaCell(op, day, 'R');
      setProvaNegozio(op, day, '');
    }
    const s2 = provaSecond(op, day);
    if (s2 && s2.shop === 'Bagheria') setProvaSecond(op, day, s2.code, 'La Malfa');
    return;
  }
  setProvaCell(op, day, val);
  setProvaNegozio(op, day, 'Bagheria');
}

function applyBagheriaVincoliDays() {
  const op = PROVA_BAGHERIA_OP;
  for (let day = 0; day < 7; day++) {
    const bv = provaVincoliBagheria[String(day)] || '';
    if (!bv || bv === 'L') continue;
    const ov = (provaVincoli[op] && provaVincoli[op][String(day)]) || '';
    if (ov === 'F' || ov === 'M' || ov === 'R') continue;
    if (provaCell(op, day) === 'F' || provaCell(op, day) === 'M') continue;
    setProvaCell(op, day, bv === 'B' ? 'B44' : bv);
    setProvaNegozio(op, day, 'Bagheria');
  }
}

function provaCellOptions(day) {
  return [
    ['', '—'],
    ['A', '09-17 (8h)'],
    ['C', '12-20 (8h)'],
    ['S', '4+4 (8h)'],
    ['S6', '09-12 / 17-20 (6h)'],
    ['S7', '09-12 / 16-20 (7h)'],
    ['7C', '11-20 (9h)'],
    ['6A', '09-15 (6h)'],
    ['6C', '14-20 (6h)'],
    ['6M', '10-16 (6h)'],
    ['5C', '15-20 (5h)'],
    ['4A', '09-13 (4h)'],
    ['4C', '16-20 (4h)'],
    ['3C', '17-20 (3h)'],
    ['B44', 'Bagheria 4+4'],
    ['B4A', 'Bagheria 09-13'],
    ['B4C', 'Bagheria 16-20'],
    ['R', 'Riposo'],
    ['F', 'Ferie'],
    ['M', 'Malattia']
  ];
}

function provaOptionSelected(saved, val) {
  if (saved === val) return true;
  if (val === '6A' && saved === 'DM') return true;
  if (val === '6C' && saved === 'DS') return true;
  if (val === 'B44' && saved === 'B') return true;
  return false;
}

function provaSnapOp(op, day) {
  const s2 = provaSecond(op, day);
  return {
    code: provaCell(op, day) || '',
    shop: (provaNegozi[op] && provaNegozi[op][String(day)]) || '',
    s2code: (s2 && s2.code) || '',
    s2shop: (s2 && s2.shop) || ''
  };
}

function provaApplyOp(op, day, snap) {
  setProvaCell(op, day, snap.code);
  setProvaNegozio(op, day, snap.shop || '');
  setProvaSecond(op, day, snap.s2code || '', snap.s2shop || 'La Malfa');
}

function sameProvaSwapRef(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'bag') return a.day === b.day;
  return a.op === b.op && a.day === b.day;
}

function doProvaSwap(a, b) {
  if (a.kind === 'op' && b.kind === 'op') {
    const sa = provaSnapOp(a.op, a.day);
    const sb = provaSnapOp(b.op, b.day);
    provaApplyOp(a.op, a.day, sb);
    provaApplyOp(b.op, b.day, sa);
    return true;
  }
  if (a.kind === 'bag' && b.kind === 'bag') {
    const va = provaBagheriaValue(a.day);
    const vb = provaBagheriaValue(b.day);
    applyBagheriaDay(a.day, vb || 'L');
    applyBagheriaDay(b.day, va || 'L');
    return true;
  }
  showToast('Scambia due operatori, oppure due celle Bagheria', 'warn');
  return false;
}

function applyProvaLockUi() {
  const locked = provaIsLocked();
  ['btn-prova-generate', 'btn-prova-swap', 'btn-prova-save', 'btn-prova-draft-save', 'btn-prova-draft-load'].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.disabled = locked;
  });
  const unlock = document.getElementById('btn-prova-unlock');
  if (unlock) {
    unlock.classList.toggle('hidden', !(provaSundayPassed() && provaIsLocked() && currentOperator === 'Santoemma'));
  }
  const grid = document.getElementById('prova-grid');
  if (grid) {
    grid.querySelectorAll('select').forEach(s => { s.disabled = locked; });
    grid.classList.toggle('is-locked', locked);
  }
}

function setProvaSwapUi() {
  const btn = document.getElementById('btn-prova-swap');
  if (btn) btn.textContent = provaSwapArmed ? 'Annulla scambio' : 'Scambia turni';
  const grid = document.getElementById('prova-grid');
  if (grid) grid.classList.toggle('is-swapping', !!provaSwapArmed);
}

function toggleProvaSwap() {
  if (provaGuardLocked()) return;
  provaSwapArmed = !provaSwapArmed;
  provaSwapA = null;
  setProvaSwapUi();
  showToast(provaSwapArmed ? 'Tocca la prima cella, poi la seconda' : 'Scambio annullato', 'info');
  renderTurniProva();
}

function pickProvaSwap(ref) {
  if (!provaSwapA) {
    provaSwapA = ref;
    showToast('Ora tocca la seconda cella');
    renderTurniProva();
    return;
  }
  if (sameProvaSwapRef(provaSwapA, ref)) {
    provaSwapA = null;
    showToast('Prima cella deselezionata');
    renderTurniProva();
    return;
  }
  const ok = doProvaSwap(provaSwapA, ref);
  provaSwapArmed = false;
  provaSwapA = null;
  renderTurniProva();
  setProvaSwapUi();
  if (ok) showToast('Turni scambiati. Premi Salva settimana.', 'success');
}

function renderTurniProva() {
  const label = document.getElementById('prova-week-label');
  const grid = document.getElementById('prova-grid');
  if (!provaWeekStart) provaWeekStart = provaMondayStr();
  const start = parseDate(provaWeekStart);
  const end = sundayOf(start);
  if (label) label.textContent = formatRange(provaWeekStart, toDateStr(end));
  syncProvaWeekInputs();
  if (!grid) return;
  let html = '<table class="prova-table"><thead><tr><th>Ore</th>';
  const todayIdx = (provaWeekStart === provaMondayStr()) ? todayProvaDayIdx() : -1;
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    html += `<th${i === todayIdx ? ' class="is-today"' : ''}>${PROVA_DAYS[i]}${i === todayIdx ? '<span class="oggi-mark">Oggi</span>' : ''}<small>${d.getDate()}</small></th>`;
  }
  html += '</tr></thead><tbody>';
  OPERATORS.forEach(op => {
    const h = provaHours(op);
    const over = h > 40 ? ' is-over' : '';
    const rc = provaRoleCounts(op);
    html += `<tr><th>${escapeHtml(op)}<small class="prova-ore${over}">${h}h · A${rc.A} S${rc.S} C${rc.C}</small></th>`;
    for (let i = 0; i < 7; i++) {
      const v = provaCell(op, i);
      const pv = provaPvClass(op, i);
      const shop = provaNegozio(op, i);
      const work = provaIsWorkCode(v) && !isBagheriaCode(v);
      const s2 = provaSecond(op, i);
      const swapOp = (provaSwapA && provaSwapA.kind === 'op' && provaSwapA.op === op && provaSwapA.day === i) ? ' is-swap-a' : '';
      html += `<td class="prova-td${i === todayIdx ? ' is-today' : ''}${swapOp}"><select class="prova-cell ${pv}" data-op="${escapeHtml(op)}" data-day="${i}" aria-label="${escapeHtml(op)} ${PROVA_DAYS[i]}">`;
      provaCellOptions(i).forEach(([val, lab]) => {
        html += `<option value="${val}"${provaOptionSelected(v, val) ? ' selected' : ''}>${lab}</option>`;
      });
      html += '</select>';
      html += `<select class="prova-neg-cell ${pv}${work ? '' : ' hidden'}" data-neg-op="${escapeHtml(op)}" data-day="${i}">`;
      PUNTI_VENDITA.forEach(n => {
        html += `<option value="${escapeHtml(n)}"${shop === n ? ' selected' : ''}>${escapeHtml(n)}</option>`;
      });
      html += '</select>';
      if (work) {
        const pv2 = s2 ? (NEGOZIO_CLASS[s2.shop] || 'pv-malfa') : 'pv-riposo';
        html += `<select class="prova-cell2 ${pv2}" data-s2-op="${escapeHtml(op)}" data-day="${i}">`;
        provaSlot2Options().forEach(([val, lab]) => {
          html += `<option value="${val}"${s2 && s2.code === val ? ' selected' : ''}>${lab}</option>`;
        });
        html += '</select>';
        html += `<select class="prova-neg-cell ${pv2}${s2 && s2.code ? '' : ' hidden'}" data-s2neg-op="${escapeHtml(op)}" data-day="${i}">`;
        PUNTI_VENDITA.forEach(n => {
          html += `<option value="${escapeHtml(n)}"${s2 && s2.shop === n ? ' selected' : ''}>${escapeHtml(n)}</option>`;
        });
        html += '</select>';
      }
      html += '</td>';
    }
    html += '</tr>';
  });
  html += '<tr class="prova-bagheria-row"><th>Bagheria<small class="prova-ore">Sorrentino</small></th>';
  for (let i = 0; i < 7; i++) {
    const cur = provaBagheriaValue(i);
    const swapBag = (provaSwapA && provaSwapA.kind === 'bag' && provaSwapA.day === i) ? ' is-swap-a' : '';
    html += `<td class="${i === todayIdx ? 'is-today' : ''}${swapBag}"><select class="prova-cell prova-bagheria-select ${cur === 'L' ? 'pv-riposo' : 'pv-bagheria'}" data-bday="${i}" aria-label="Bagheria ${PROVA_DAYS[i]}">`;
    provaBagheriaOptions().forEach(([val, lab]) => {
      html += `<option value="${val}"${cur === val ? ' selected' : ''}>${lab}</option>`;
    });
    html += '</select></td>';
  }
  html += '</tr>';
  html += '</tbody></table>';
  grid.innerHTML = html;
  grid.querySelectorAll('select.prova-cell[data-op]').forEach(sel => {
    sel.onchange = () => {
      const op = sel.dataset.op;
      const day = parseInt(sel.dataset.day, 10);
      setProvaCell(op, day, sel.value);
      if (!provaIsWorkCode(sel.value)) {
        setProvaNegozio(op, day, '');
        setProvaSecond(op, day, '');
      } else if (isBagheriaCode(sel.value)) setProvaNegozio(op, day, 'Bagheria');
      else if (!provaNegozi[op] || !provaNegozi[op][String(day)]) setProvaNegozio(op, day, 'La Malfa');
      if (sel.value === 'A' || sel.value === 'C' || sel.value === 'S' || sel.value === 'S6' || sel.value === 'S7' || sel.value === '7C' || sel.value === 'B44') setProvaSecond(op, day, '');
      renderTurniProva();
    };
  });
  grid.querySelectorAll('select.prova-neg-cell[data-neg-op]').forEach(sel => {
    sel.onchange = () => {
      const op = sel.dataset.negOp;
      const day = parseInt(sel.dataset.day, 10);
      const shop = sel.value;
      setProvaNegozio(op, day, shop);
      if (shop !== 'Bagheria' && isBagheriaCode(provaCell(op, day))) {
        const c = provaCell(op, day);
        if (c === 'B4A') setProvaCell(op, day, '4A');
        else if (c === 'B4C') setProvaCell(op, day, '4C');
        else if (c === 'B44' || c === 'B') setProvaCell(op, day, 'S');
      }
      renderTurniProva();
    };
  });
  grid.querySelectorAll('select[data-s2-op]').forEach(sel => {
    sel.onchange = () => {
      const op = sel.dataset.s2Op;
      const day = parseInt(sel.dataset.day, 10);
      const shopSel = grid.querySelector('select[data-s2neg-op="' + op + '"][data-day="' + day + '"]');
      const shop = (shopSel && shopSel.value) || 'La Malfa';
      setProvaSecond(op, day, sel.value, shop);
      renderTurniProva();
    };
  });
  grid.querySelectorAll('select[data-s2neg-op]').forEach(sel => {
    sel.onchange = () => {
      const op = sel.dataset.s2negOp;
      const day = parseInt(sel.dataset.day, 10);
      const cur = provaSecond(op, day);
      if (!cur) return;
      setProvaSecond(op, day, cur.code, sel.value);
      renderTurniProva();
    };
  });
  grid.querySelectorAll('select.prova-bagheria-select').forEach(sel => {
    sel.onchange = () => {
      applyBagheriaDay(parseInt(sel.dataset.bday, 10), sel.value);
      renderTurniProva();
    };
  });
  const swapSels = grid.querySelectorAll('select.prova-cell[data-op], select.prova-bagheria-select');
  swapSels.forEach(sel => {
    sel.addEventListener('mousedown', (e) => {
      if (!provaSwapArmed) return;
      e.preventDefault();
      e.stopPropagation();
      const ref = sel.classList.contains('prova-bagheria-select')
        ? { kind: 'bag', day: parseInt(sel.dataset.bday, 10) }
        : { kind: 'op', op: sel.dataset.op, day: parseInt(sel.dataset.day, 10) };
      pickProvaSwap(ref);
    }, true);
  });
  if (provaSwapArmed) grid.classList.add('is-swapping');
  setProvaSwapUi();
  applyProvaLockUi();
  renderProvaCheck();
}

function provaHours(op) {
  let h = 0;
  for (let i = 0; i < 7; i++) h += provaDayHours(op, i);
  return h;
}

function provaPresent(code, hour) {
  const spans = PROVA_SPANS[code];
  if (!spans) return false;
  return spans.some(([a, b]) => hour >= a && hour < b);
}

function provaValidate() {
  const issues = [];
  OPERATORS.forEach(op => {
    const h = provaHours(op);
    if (h > 40) issues.push(op + ': ' + h + ' ore (max 40)');
    if (h < 40 && h > 0) issues.push(op + ': ' + h + ' ore (serve 40)');
    for (let d = 0; d < 7; d++) {
      const dh = provaDayHours(op, d);
      if (dh > 9) issues.push(op + ' ' + PROVA_DAYS[d] + ': ' + dh + 'h in un giorno (max 9)');
    }
  });
  for (let day = 0; day < 7; day++) {
    const name = PROVA_DAYS[day];
    const codes = OPERATORS.map(op => provaCell(op, day));
    if (day === 6) {
      const main = OPERATORS.filter(op => provaAtMain(op, 6));
      const dm = main.filter(op => { const c = provaCell(op, 6); return c === 'DM' || c === '6A'; }).length;
      const ds = main.filter(op => { const c = provaCell(op, 6); return c === 'DS' || c === '6C'; }).length;
      if (dm !== 1 || ds !== 1) {
        issues.push('Domenica La Malfa: 2 persone, una 09-15 e una 14-20');
      }
    } else {
      const atOpen = OPERATORS.filter(op => provaAtMainHour(op, day, 9)).length;
      const atClose = OPERATORS.filter(op => provaAtMainHour(op, day, 19)).length;
      if (atOpen < 1) issues.push(name + ' (La Malfa): nessuno in apertura (09:00)');
      if (atClose < 2) issues.push(name + ' (La Malfa): in chiusura ' + atClose + ' persone (min 2)');
      for (let h = 9; h < 20; h++) {
        const n = OPERATORS.filter(op => provaAtMainHour(op, day, h)).length;
        if (n < 1) {
          issues.push(name + ': scoperto alle ' + String(h).padStart(2, '0') + ':00');
          break;
        }
      }
    }
  }
  return issues;
}

function renderProvaCheck() {
  const el = document.getElementById('prova-check');
  if (!el) return;
  applyProvaLockUi();
  if (provaSundayPassed()) {
    el.className = 'prova-check is-warn';
    el.innerHTML = provaIsLocked()
      ? 'Settimana chiusa — solo consultazione.' + (currentOperator === 'Santoemma' ? ' Santoemma può sbloccare per una correzione.' : '')
      : 'Settimana passata sbloccata per correzione. Ricorda di Salvare.';
    return;
  }
  const issues = provaValidate();
  const empty = OPERATORS.every(op => {
    for (let i = 0; i < 7; i++) if (provaCell(op, i)) return false;
    return true;
  });
  if (empty) {
    el.className = 'prova-check is-empty';
    el.innerHTML = 'Settimana vuota. Premi <strong>Genera settimana</strong>.';
    return;
  }
  if (!issues.length) {
    el.className = 'prova-check is-ok';
    el.innerHTML = 'Regole ok: chiusura ≥2, tutti a 40 ore, aperture/chiusure/spezzati equilibrati.';
    return;
  }
  el.className = 'prova-check is-warn';
  el.innerHTML = issues.map(x => '<div>' + escapeHtml(x) + '</div>').join('');
}

function provaWeekNumber(mondayStr) {
  const t = parseDate(mondayStr || provaMondayStr()).getTime();
  const e = parseDate('2020-01-06').getTime();
  return Math.floor((t - e) / 604800000);
}

function provaRoleOf(code) {
  if (code === 'A' || code === 'DM' || code === '6A' || code === '4A') return 'A';
  if (code === 'C' || code === 'DS' || code === '7C' || code === '6C' || code === '5C' || code === '4C' || code === '3C') return 'C';
  if (code === 'S' || code === 'S6' || code === 'S7') return 'S';
  return null;
}

function provaRoleCounts(op) {
  const c = { A: 0, S: 0, C: 0 };
  for (let i = 0; i < 7; i++) {
    const r = provaRoleOf(provaCell(op, i));
    if (r) c[r]++;
  }
  return c;
}

function provaUniquePerms(arr) {
  const out = [];
  function rec(path, rest) {
    if (!rest.length) { out.push(path); return; }
    const seen = {};
    rest.forEach((v, i) => {
      if (seen[v]) return;
      seen[v] = true;
      rec(path.concat(v), rest.slice(0, i).concat(rest.slice(i + 1)));
    });
  }
  rec([], arr);
  return out;
}

function provaFairScore(counts) {
  let s = 0;
  ['A', 'S', 'C'].forEach(t => {
    const vals = OPERATORS.map(op => counts[op][t]);
    const max = Math.max.apply(null, vals);
    const min = Math.min.apply(null, vals);
    const sum = vals.reduce((a, b) => a + b, 0);
    const avg = sum / vals.length;
    s += (max - min) * 40;
    vals.forEach(v => { s += (v - avg) * (v - avg) * 12; });
  });
  OPERATORS.forEach(op => {
    const c = counts[op];
    const work = c.A + c.S + c.C;
    if (work >= 2) s += Math.abs(c.A - c.C) * 14;
    if (work >= 2 && c.S === 0) s += 26;
    if (work >= 3 && c.A === 0) s += 24;
    if (work >= 3 && c.C === 0) s += 24;
  });
  let totA = 0, totS = 0, totC = 0;
  OPERATORS.forEach(op => {
    totA += counts[op].A;
    totS += counts[op].S;
    totC += counts[op].C;
  });
  if (totS * 3 < totA + totC) s += (totA + totC - totS * 3) * 8;
  return s;
}

function provaMakePack(need, nDays) {
  if (need < 0 || nDays < 0) return null;
  if (nDays === 0) return need === 0 ? [] : null;
  if (need === 0) {
    const z = [];
    for (let i = 0; i < nDays; i++) z.push(0);
    return z;
  }
  if (need > 9 * nDays) return null;
  const out = [];
  function rec(left, days) {
    if (days === 0) return left === 0;
    const sizes = [9, 8, 7, 6, 5, 4, 3, 0];
    for (let i = 0; i < sizes.length; i++) {
      const s = sizes[i];
      if (s > left) continue;
      if (left - s > 9 * (days - 1)) continue;
      out.push(s);
      if (rec(left - s, days - 1)) return true;
      out.pop();
    }
    return false;
  }
  return rec(need, nDays) ? out.slice() : null;
}

function provaTakeBag(bag, prefer) {
  for (let p = 0; p < prefer.length; p++) {
    const i = bag.indexOf(prefer[p]);
    if (i >= 0) {
      bag.splice(i, 1);
      return prefer[p];
    }
  }
  if (!bag.length) return 0;
  bag.sort((a, b) => b - a);
  return bag.shift();
}

const PROVA_CODES_BY_H = {
  8: ['A', 'C', 'S'],
  9: ['7C'],
  7: ['S7'],
  6: ['6A', '6C', 'S6', '6M'],
  5: ['5C'],
  4: ['4A', '4C'],
  3: ['3C']
};

function provaCodesCover(codes, day) {
  function pres(hour) {
    return OPERATORS.some(op => provaAtMainHour(op, day, hour, codes[op]));
  }
  if (!pres(9)) return false;
  let close = 0;
  OPERATORS.forEach(op => { if (provaPresent(codes[op], 19)) close++; });
  if (close < 2) return false;
  for (let h = 9; h < 20; h++) if (!pres(h)) return false;
  return true;
}

function provaPickCodes(hourAssign, preset, counts, day) {
  const workers = Object.keys(hourAssign);
  const codes = {};
  OPERATORS.forEach(op => { codes[op] = preset[op] || 'R'; });
  let best = null;
  let bestScore = Infinity;
  function rec(i) {
    if (i === workers.length) {
      if (!provaCodesCover(codes, day)) return;
      const next = {};
      OPERATORS.forEach(op => {
        next[op] = { A: counts[op].A, S: counts[op].S, C: counts[op].C };
      });
      workers.forEach(op => {
        const rk = provaRoleOf(codes[op]);
        if (rk) next[op][rk] += 1;
      });
      const sc = provaFairScore(next);
      if (sc < bestScore) {
        bestScore = sc;
        best = {};
        OPERATORS.forEach(op => { best[op] = codes[op]; });
      }
      return;
    }
    const op = workers[i];
    const list = PROVA_CODES_BY_H[hourAssign[op]] || ['R'];
    for (let k = 0; k < list.length; k++) {
      codes[op] = list[k];
      rec(i + 1);
    }
  }
  rec(0);
  if (best) return best;
  workers.forEach(op => {
    codes[op] = (PROVA_CODES_BY_H[hourAssign[op]] || ['R'])[0];
  });
  return codes;
}

function generateTurniProva() {
  if (provaGuardLocked()) return;
  if (!provaWeekStart) provaWeekStart = provaMondayStr();
  const ops = OPERATORS.slice();
  const w = provaWeekNumber(provaWeekStart);
  const vFor = (op, day) => (provaVincoli[op] && provaVincoli[op][String(day)]) || '';

  provaCelle = {};
  provaNegozi = {};
  provaSlot2 = {};
  ops.forEach(op => { provaCelle[op] = {}; });

  let dm = null;
  let ds = null;
  const sunBusy = new Set();
  ops.forEach(op => {
    const v = vFor(op, 6);
    if (v === 'DM' || v === 'A' || v === '6A') dm = op;
    if (v === 'DS' || v === 'C' || v === '6C') ds = op;
    if (isBagheriaCode(v)) {
      setProvaCell(op, 6, v === 'B' ? 'B44' : v);
      sunBusy.add(op);
    }
    if (v === 'R' || v === 'F' || v === 'M') {
      setProvaCell(op, 6, v);
      sunBusy.add(op);
    }
  });
  const availableSun = ops.filter(op => !sunBusy.has(op) && op !== dm && op !== ds);
  const pairs = [[0, 1], [2, 3], [0, 2], [1, 3], [0, 3], [1, 2]];
  const pair = pairs[((w % 6) + 6) % 6];
  if (!dm) {
    const cand = availableSun.filter(op => op !== ds);
    dm = cand.find(op => op === ops[pair[0]]) || cand[0] || null;
  }
  if (!ds) {
    const cand = availableSun.filter(op => op !== dm);
    ds = cand.find(op => op === ops[pair[1]]) || cand[0] || null;
  }
  if (dm === ds) ds = ops.find(op => op !== dm && !sunBusy.has(op)) || ds;
  if (w % 2 && dm && ds && !vFor(dm, 6) && !vFor(ds, 6)) {
    const t = dm; dm = ds; ds = t;
  }
  ops.forEach(op => {
    if (provaCell(op, 6)) return;
    if (op === dm) { setProvaCell(op, 6, '6A'); setProvaNegozio(op, 6, 'La Malfa'); }
    else if (op === ds) { setProvaCell(op, 6, '6C'); setProvaNegozio(op, 6, 'La Malfa'); }
    else setProvaCell(op, 6, 'R');
  });
  applyBagheriaVincoliDays();

  const LOCK_CODES = ['A', 'C', 'S', 'S6', 'S7', '7C', '6A', '6C', '6M', '5C', '4A', '4C', '3C'];
  for (let day = 0; day < 6; day++) {
    ops.forEach(op => {
      const v = vFor(op, day);
      if (v === 'F' || v === 'M') { setProvaCell(op, day, v); setProvaNegozio(op, day, ''); }
      else if (v === 'R') { setProvaCell(op, day, 'R'); setProvaNegozio(op, day, ''); }
      else if (isBagheriaCode(v)) {
        setProvaCell(op, day, v === 'B' ? 'B44' : v);
        setProvaNegozio(op, day, 'Bagheria');
      }
      else if (LOCK_CODES.indexOf(v) >= 0) {
        setProvaCell(op, day, v);
        setProvaNegozio(op, day, vNegozio(op, day) || 'La Malfa');
      }
    });
  }
  applyBagheriaVincoliDays();
  ops.forEach(op => {
    for (let day = 0; day < 7; day++) {
      const s = provaVincoliSlot2[op] && provaVincoliSlot2[op][String(day)];
      if (s && s.code) setProvaSecond(op, day, s.code, s.shop || 'La Malfa');
    }
  });

  const hours = {};
  ops.forEach(op => {
    hours[op] = 0;
    for (let d = 0; d < 7; d++) hours[op] += provaDayHours(op, d);
  });

  const flexDays = {};
  const bags = {};
  const packFail = [];
  ops.forEach(op => {
    const flex = [];
    for (let d = 0; d < 6; d++) if (!provaCell(op, d)) flex.push(d);
    flexDays[op] = flex;
    const pack = provaMakePack(40 - hours[op], flex.length);
    if (!pack) {
      packFail.push(op);
      bags[op] = [];
      for (let i = 0; i < flex.length; i++) bags[op].push(0);
    } else {
      bags[op] = pack.slice();
    }
  });

  const counts = {};
  ops.forEach(op => { counts[op] = { A: 0, S: 0, C: 0 }; });
  ops.forEach(op => {
    for (let d = 0; d < 7; d++) {
      const rk = provaRoleOf(provaCell(op, d));
      if (rk) counts[op][rk] += 1;
    }
  });

  for (let day = 0; day < 6; day++) {
    const preset = {};
    ops.forEach(op => {
      const c = provaCell(op, day);
      if (c) preset[op] = c;
    });
    const flex = ops.filter(op => flexDays[op].indexOf(day) >= 0);
    const alreadyStore = ops.filter(op => provaAtMain(op, day, preset[op])).length;
    const target = 3;
    let needWorkers = target - alreadyStore;
    if (needWorkers < 0) needWorkers = 0;
    if (needWorkers > flex.length) needWorkers = flex.length;
    let restN = flex.length - needWorkers;

    const with0 = flex.filter(op => bags[op].indexOf(0) >= 0);
    with0.sort((a, b) => ((ops.indexOf(a) + w + day) % 4) - ((ops.indexOf(b) + w + day) % 4));
    if (restN > with0.length) restN = with0.length;
    const resters = with0.slice(0, restN);
    const workersFlex = flex.filter(op => resters.indexOf(op) < 0);

    resters.forEach(op => {
      provaTakeBag(bags[op], [0]);
      setProvaCell(op, day, 'R');
      preset[op] = 'R';
    });
    const hourAssign = {};
    workersFlex.forEach(op => {
      const h = provaTakeBag(bags[op], [9, 8, 7, 6, 5, 4, 3]);
      if (!h) {
        setProvaCell(op, day, 'R');
        preset[op] = 'R';
      } else {
        hourAssign[op] = h;
      }
    });

    const picked = provaPickCodes(hourAssign, preset, counts, day);
    Object.keys(hourAssign).forEach(op => {
      const role = picked[op] || (PROVA_CODES_BY_H[hourAssign[op]] || ['C'])[0];
      setProvaCell(op, day, role);
      setProvaNegozio(op, day, 'La Malfa');
      hours[op] += PROVA_HOURS[role] || 0;
      const rk = provaRoleOf(role);
      if (rk) counts[op][rk] += 1;
    });
  }

  provaSyncNegozi();
  provaFillExact40();
  provaRepairHours();
  renderTurniProva();
  const not40 = OPERATORS.filter(op => provaHours(op) !== 40);
  if (packFail.length) showToast('Vincoli troppo stretti per 40h: ' + packFail.join(', '), 'warn');
  else if (not40.length) showToast(not40[0] + ' è a ' + provaHours(not40[0]) + 'h (serve 40). Ritocca a mano.', 'warn');
  else if (provaValidate().length) showToast('40h ok, ma controlla il riquadro giallo (copertura)', 'warn');
  else showToast('Tutti a 40 ore. Controlla e Salva.', 'success');
}

function provaFillExact40() {
  const vFor = (op, day) => (provaVincoli[op] && provaVincoli[op][String(day)]) || '';
  OPERATORS.forEach(op => {
    let guard = 0;
    while (provaHours(op) < 40 && guard++ < 6) {
      const miss = 40 - provaHours(op);
      const want = miss >= 9 ? 9 : miss >= 8 ? 8 : miss >= 7 ? 7 : miss >= 6 ? 6 : miss >= 5 ? 5 : miss >= 4 ? 4 : miss >= 3 ? 3 : 0;
      if (!want) break;
      const c = provaRoleCounts(op);
      let code;
      if (want === 9) code = '7C';
      else if (want === 8) {
        if (c.S <= c.A && c.S <= c.C) code = 'S';
        else if (c.A <= c.C) code = 'A';
        else code = 'C';
      } else if (want === 7) code = 'S7';
      else if (want === 6) code = c.S <= c.A && c.S <= c.C ? 'S6' : (c.A <= c.C ? '6A' : '6C');
      else if (want === 5) code = '5C';
      else if (want === 3) code = '3C';
      else code = c.A <= c.C ? '4A' : '4C';
      let done = false;
      for (let day = 0; day < 6; day++) {
        if (vFor(op, day)) continue;
        const cur = provaCell(op, day);
        if (cur && cur !== 'R') continue;
        setProvaCell(op, day, code);
        done = true;
        break;
      }
      if (!done) break;
    }
  });
}

function provaRepairHours() {
  const vFor = (op, day) => (provaVincoli[op] && provaVincoli[op][String(day)]) || '';
  OPERATORS.forEach(op => {
    let guard = 0;
    while (provaHours(op) > 40 && guard++ < 6) {
      let done = false;
      for (let day = 5; day >= 0; day--) {
        if (vFor(op, day)) continue;
        const code = provaCell(op, day);
        if (!code || code === 'R' || code === 'F' || code === 'M') continue;
        setProvaCell(op, day, 'R');
        const atClose = OPERATORS.filter(o => provaPresent(provaCell(o, day), 19)).length;
        const atOpen = OPERATORS.filter(o => provaPresent(provaCell(o, day), 9)).length;
        let hole = false;
        for (let h = 9; h < 20; h++) {
          if (!OPERATORS.some(o => provaPresent(provaCell(o, day), h))) { hole = true; break; }
        }
        if (atClose >= 2 && atOpen >= 1 && !hole) { done = true; break; }
        setProvaCell(op, day, code);
      }
      if (!done) break;
    }
  });
}

function provaVincoloOptions(day) {
  return [
    ['', 'Libero'],
    ['R', 'Riposo'],
    ['F', 'Ferie'],
    ['M', 'Malattia (8h)'],
    ['A', '09-17 (8h)'],
    ['C', '12-20 (8h)'],
    ['S', 'Spezzato 4+4 (8h)'],
    ['S6', 'Spezzato 09-12 / 17-20 (6h)'],
    ['S7', 'Spezzato 09-12 / 16-20 (7h)'],
    ['7C', '11-20 (9h)'],
    ['6A', '09-15 (6h)'],
    ['6C', '14-20 (6h)'],
    ['6M', '10-16 (6h)'],
    ['5C', '15-20 (5h)'],
    ['4A', '09-13 (4h)'],
    ['4C', '16-20 (4h)'],
    ['3C', '17-20 (3h)']
  ];
}

function renderProvaVincoliForm() {
  const box = document.getElementById('prova-vincoli-form');
  if (!box) return;
  if (!provaWeekStart) provaWeekStart = provaMondayStr();
  let html = '<div class="prova-vincoli-table-wrap"><table class="prova-vincoli-table"><thead><tr><th></th>';
  PROVA_DAYS.forEach((d, i) => { html += '<th>' + d + '</th>'; });
  html += '</tr></thead><tbody>';
  OPERATORS.forEach(op => {
    html += '<tr><th>' + escapeHtml(op) + '</th>';
    for (let i = 0; i < 7; i++) {
      const cur = (provaVincoli[op] && provaVincoli[op][String(i)]) || '';
      const shopRaw = provaVincoliNegozi[op] && provaVincoliNegozi[op][String(i)];
      const shop = typeof shopRaw === 'string' ? shopRaw : 'La Malfa';
      const work = provaIsWorkCode(cur) && !isBagheriaCode(cur);
      const s2 = (provaVincoliSlot2[op] && provaVincoliSlot2[op][String(i)]) || {};
      html += '<td class="vincolo-td">';
      html += '<select class="vincolo-orario" data-op="' + escapeHtml(op) + '" data-day="' + i + '">';
      provaVincoloOptions(i).forEach(([val, lab]) => {
        html += '<option value="' + val + '"' + (cur === val ? ' selected' : '') + '>' + lab + '</option>';
      });
      html += '</select>';
      html += '<select class="vincolo-negozio ' + (NEGOZIO_CLASS[shop] || 'pv-malfa') + (work ? '' : ' hidden') + '" data-neg-op="' + escapeHtml(op) + '" data-day="' + i + '">';
      PUNTI_VENDITA.forEach(n => {
        html += '<option value="' + escapeHtml(n) + '"' + (shop === n ? ' selected' : '') + '>' + escapeHtml(n) + '</option>';
      });
      html += '</select>';
      html += '<select class="vincolo-orario2' + (work ? '' : ' hidden') + '" data-s2-op="' + escapeHtml(op) + '" data-day="' + i + '">';
      provaSlot2Options().forEach(([val, lab]) => {
        html += '<option value="' + val + '"' + (s2.code === val ? ' selected' : '') + '>' + lab + '</option>';
      });
      html += '</select>';
      html += '<select class="vincolo-negozio2 ' + (NEGOZIO_CLASS[s2.shop] || 'pv-malfa') + (s2.code ? '' : ' hidden') + '" data-s2neg-op="' + escapeHtml(op) + '" data-day="' + i + '">';
      PUNTI_VENDITA.forEach(n => {
        html += '<option value="' + escapeHtml(n) + '"' + (s2.shop === n ? ' selected' : '') + '>' + escapeHtml(n) + '</option>';
      });
      html += '</select></td>';
    }
    html += '</tr>';
  });
  html += '<tr class="prova-bagheria-row"><th>Bagheria<small class="prova-ore">Sorrentino</small></th>';
  for (let i = 0; i < 7; i++) {
    const cur = provaVincoliBagheria[String(i)] || 'L';
    html += '<td><select data-bag="1" data-day="' + i + '">';
    provaBagheriaOptions().forEach(([val, lab]) => {
      html += '<option value="' + val + '"' + (cur === val ? ' selected' : '') + '>' + lab + '</option>';
    });
    html += '</select></td>';
  }
  html += '</tr>';
  html += '</tbody></table></div>';
  box.innerHTML = html;
  box.querySelectorAll('select.vincolo-orario').forEach(sel => {
    sel.onchange = () => {
      const td = sel.parentElement;
      const shop = td.querySelector('select.vincolo-negozio');
      const o2 = td.querySelector('select.vincolo-orario2');
      const n2 = td.querySelector('select.vincolo-negozio2');
      const v = sel.value;
      const work = provaIsWorkCode(v) && !isBagheriaCode(v);
      if (shop) shop.classList.toggle('hidden', !work);
      if (o2) o2.classList.toggle('hidden', !work);
      if (n2 && o2) n2.classList.toggle('hidden', !work || !o2.value);
    };
  });
  box.querySelectorAll('select.vincolo-orario2').forEach(sel => {
    sel.onchange = () => {
      const n2 = sel.parentElement.querySelector('select.vincolo-negozio2');
      if (n2) n2.classList.toggle('hidden', !sel.value);
    };
  });
  box.querySelectorAll('select.vincolo-negozio').forEach(sel => {
    sel.onchange = () => {
      PUNTI_VENDITA.forEach(n => sel.classList.remove(NEGOZIO_CLASS[n]));
      sel.classList.add(NEGOZIO_CLASS[sel.value] || 'pv-malfa');
    };
  });
}

function collectProvaVincoli() {
  provaVincoli = {};
  provaVincoliNegozi = {};
  provaVincoliBagheria = {};
  provaVincoliSlot2 = {};
  document.querySelectorAll('#prova-vincoli-form select').forEach(sel => {
    if (sel.dataset.bag) {
      provaVincoliBagheria[sel.dataset.day] = sel.value || 'L';
      return;
    }
    if (sel.dataset.s2Op) {
      const op = sel.dataset.s2Op;
      if (!provaVincoliSlot2[op]) provaVincoliSlot2[op] = {};
      const shopSel = document.querySelector('#prova-vincoli-form select[data-s2neg-op="' + op + '"][data-day="' + sel.dataset.day + '"]');
      if (sel.value) provaVincoliSlot2[op][sel.dataset.day] = { code: sel.value, shop: (shopSel && shopSel.value) || 'La Malfa' };
      return;
    }
    if (sel.dataset.s2negOp) return;
    if (sel.dataset.negOp) {
      const op = sel.dataset.negOp;
      if (!provaVincoliNegozi[op]) provaVincoliNegozi[op] = {};
      provaVincoliNegozi[op][sel.dataset.day] = sel.value || 'La Malfa';
      return;
    }
    if (!sel.value) return;
    const op = sel.dataset.op;
    if (!op) return;
    if (!provaVincoli[op]) provaVincoli[op] = {};
    provaVincoli[op][sel.dataset.day] = sel.value;
  });
}

function openProvaVincoli() {
  if (provaGuardLocked()) return;
  renderProvaVincoliForm();
  syncProvaWeekInputs();
  const el = document.getElementById('prova-vincoli-overlay');
  if (el) el.classList.remove('hidden');
}

function closeProvaVincoli() {
  const el = document.getElementById('prova-vincoli-overlay');
  if (el) el.classList.add('hidden');
}

function confirmProvaVincoli() {
  const w = document.getElementById('prova-vincoli-week');
  if (w && w.value) setProvaWeekFromDate(w.value, false);
  collectProvaVincoli();
  closeProvaVincoli();
  generateTurniProva();
}

async function loadTurniProva() {
  if (!provaWeekStart) provaWeekStart = provaMondayStr();
  renderTurniProva();
  const st = document.getElementById('prova-status');
  if (!supabase) {
    if (st) st.textContent = 'Cloud non disponibile — solo su questo telefono.';
    loadMonteOre();
    return;
  }
  if (provaTableMissing) {
    if (st) st.textContent = 'Tabella mancante: premi Copia SQL tabella e avviala su Supabase.';
    loadMonteOre();
    return;
  }
  try {
    const { data, error } = await supabase
      .from('turni_prova')
      .select('celle,updated_by,updated_at')
      .eq('settimana_inizio', provaWeekStart)
      .limit(1);
    if (error) {
      const msg = (error.message || '') + '';
      if (/does not exist|schema cache|42P01/i.test(msg)) provaTableMissing = true;
      if (st) st.textContent = provaTableMissing
        ? 'Tabella mancante: premi Copia SQL tabella e avviala su Supabase.'
        : ('Errore: ' + error.message);
      loadMonteOre();
      return;
    }
    const row = data && data[0];
    provaUnpackCelle(row && row.celle);
    renderTurniProva();
    updateProvaDraftHint();
    if (st) {
      st.textContent = row && row.updated_by
        ? ('Ultimo salvataggio: ' + row.updated_by + (row.updated_at ? ' · ' + new Date(row.updated_at).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''))
        : 'Settimana vuota. Tocca le celle e poi Salva.';
    }
  } catch (e) {
    if (st) st.textContent = 'Errore di rete';
  }
  loadMonteOre();
}

let provaShareBlob = null;
let provaShareUrl = '';

function provaExportColors(op, day) {
  const c = provaCell(op, day);
  if (c === 'F') return { bg: '#fce7f3', fg: '#9d174d' };
  if (c === 'M') return { bg: '#fef3c7', fg: '#92400e' };
  if (!c || c === 'R') return { bg: '#f4efe6', fg: '#6f645b' };
  const n = provaNegozio(op, day);
  if (n === 'Rizzo') return { bg: '#dbeafe', fg: '#1d4ed8' };
  if (n === 'San Lorenzo') return { bg: '#dcfce7', fg: '#166534' };
  if (n === 'Bagheria' || isBagheriaCode(c)) return { bg: '#e0f2fe', fg: '#075985' };
  return { bg: '#ffedd5', fg: '#9a3412' };
}

function provaShopCode(n) {
  if (n === 'La Malfa') return 'LM';
  if (n === 'Rizzo') return 'RZ';
  if (n === 'San Lorenzo') return 'SL';
  if (n === 'Bagheria') return 'BG';
  return n || '';
}

function printTurniProvaCell(op, day) {
  const c = provaCell(op, day);
  const shop = provaNegozio(op, day);
  const s2 = provaSecond(op, day);
  if (!c || c === 'R') return '<span class="off">Riposo</span>';
  if (c === 'F') return '<span class="ferie">FERIE</span>';
  if (c === 'M') return '<span class="ferie">MALATTIA</span>';
  let html = '<b>' + escapeHtml(PROVA_LABEL[c] || c) + '</b>';
  html += '<div class="shop">' + escapeHtml(provaShopCode(shop) || shop) + '</div>';
  if (s2 && s2.code) {
    html += '<b>' + escapeHtml(PROVA_LABEL[s2.code] || s2.code) + '</b>';
    html += '<div class="shop">' + escapeHtml(provaShopCode(s2.shop) || s2.shop || '') + '</div>';
  }
  return html;
}

function printTurniProva() {
  const start = provaWeekStart || provaMondayStr();
  const end = toDateStr(sundayOf(parseDate(start)));
  let head = '<tr><th>Operatore</th>';
  for (let i = 0; i < 7; i++) {
    const d = parseDate(start);
    d.setDate(d.getDate() + i);
    head += '<th>' + PROVA_DAYS[i] + '<br>' + d.getDate() + '/' + (d.getMonth() + 1) + '</th>';
  }
  head += '</tr>';
  let body = '';
  OPERATORS.forEach(op => {
    body += '<tr><th>' + escapeHtml(op) + '</th>';
    for (let i = 0; i < 7; i++) body += '<td>' + printTurniProvaCell(op, i) + '</td>';
    body += '</tr>';
  });
  body += '<tr><th>Bagheria<br><span class="sub">Sorrentino</span></th>';
  for (let i = 0; i < 7; i++) {
    const cur = provaBagheriaValue(i);
    const work = cur && cur !== 'L';
    body += '<td>' + (work ? ('<b>' + escapeHtml(PROVA_LABEL[cur] || cur) + '</b><div class="shop">BG</div>') : '<span class="off">Libero</span>') + '</td>';
  }
  body += '</tr>';
  const html = `<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><title>Turni ${escapeHtml(formatRange(start, end))}</title>
<style>
@page { size: A4 landscape; margin: 8mm; }
* { box-sizing: border-box; }
body { margin: 0; color: #000; background: #fff; font-family: Arial, Helvetica, sans-serif; }
h1 { font-size: 16px; margin: 0 0 4px; }
.range { font-size: 13px; margin: 0 0 10px; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th, td { border: 1px solid #000; padding: 6px 4px; text-align: center; vertical-align: middle; font-size: 12px; }
thead th { font-size: 11px; font-weight: 700; }
tbody th { text-align: left; width: 15%; font-size: 13px; }
.shop { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; margin-top: 2px; }
.off { font-style: italic; }
.ferie { font-weight: 800; text-decoration: underline; }
.sub { font-weight: 400; font-size: 11px; }
.leg { margin-top: 10px; font-size: 11px; }
.leg b { display: inline-block; min-width: 22px; }
@media print { button { display: none !important; } }
.no-print { margin-top: 12px; }
</style></head><body>
<h1>Pet Store La Malfa — Turni 2.0</h1>
<p class="range">${escapeHtml(formatRange(start, end))}</p>
<table>
<thead>${head}</thead>
<tbody>${body}</tbody>
</table>
<p class="leg"><b>LM</b> La Malfa &nbsp;&nbsp; <b>RZ</b> Rizzo &nbsp;&nbsp; <b>SL</b> San Lorenzo &nbsp;&nbsp; <b>BG</b> Bagheria</p>
<p class="no-print"><button onclick="window.print()">Stampa / Salva PDF</button></p>
<script>window.onload=function(){setTimeout(function(){window.print();},250);}</script>
</body></html>`;
  const w = window.open('', '_blank');
  if (!w) {
    showToast('Consenti i popup per stampare', 'warn');
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

function provaShopShort(n) {
  if (n === 'La Malfa') return 'Malfa';
  if (n === 'San Lorenzo') return 'S. Lorenzo';
  return n || '';
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawTurniProvaCanvas() {
  if (!provaWeekStart) provaWeekStart = provaMondayStr();
  const start = parseDate(provaWeekStart);
  const range = formatRange(provaWeekStart, toDateStr(sundayOf(start)));
  const pad = 28;
  const nameW = 150;
  const dayW = 92;
  const headH = 46;
  const rowH = 86;
  const titleH = 52;
  const subH = 28;
  const legendH = 44;
  const footH = 28;
  const cols = 7;
  const rows = OPERATORS.length + 1;
  const W = pad * 2 + nameW + cols * dayW;
  const H = pad + titleH + subH + headH + rows * rowH + legendH + footH + pad;
  const dpr = 2;
  const canvas = document.createElement('canvas');
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#fbf7f2';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#2a211c';
  ctx.font = '700 22px "DM Sans", system-ui, sans-serif';
  ctx.fillText('Pet Store La Malfa — Turni 2.0', pad, pad + 22);
  ctx.font = '600 16px "DM Sans", system-ui, sans-serif';
  ctx.fillStyle = '#6f645b';
  ctx.fillText(range, pad, pad + titleH);
  const tableY = pad + titleH + subH;
  ctx.font = '700 12px "DM Sans", system-ui, sans-serif';
  ctx.fillStyle = '#6f645b';
  ctx.fillText('Operatore', pad + 8, tableY + 28);
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const x = pad + nameW + i * dayW;
    ctx.fillStyle = '#6f645b';
    ctx.textAlign = 'center';
    ctx.font = '700 12px "DM Sans", system-ui, sans-serif';
    ctx.fillText(PROVA_DAYS[i], x + dayW / 2, tableY + 18);
    ctx.font = '600 11px "DM Sans", system-ui, sans-serif';
    ctx.fillText(String(d.getDate()), x + dayW / 2, tableY + 34);
    ctx.textAlign = 'left';
  }
  OPERATORS.forEach((op, ri) => {
    const y = tableY + headH + ri * rowH;
    ctx.fillStyle = '#2a211c';
    ctx.font = '700 14px "DM Sans", system-ui, sans-serif';
    ctx.fillText(op, pad + 6, y + 40);
    for (let i = 0; i < 7; i++) {
      const x = pad + nameW + i * dayW + 4;
      const col = provaExportColors(op, i);
      const code = provaCell(op, i);
      roundRectPath(ctx, x, y + 8, dayW - 8, rowH - 16, 8);
      ctx.fillStyle = col.bg;
      ctx.fill();
      ctx.fillStyle = col.fg;
      ctx.textAlign = 'center';
      ctx.font = '800 11px "DM Sans", system-ui, sans-serif';
      ctx.fillText(PROVA_LABEL[code] || '·', x + (dayW - 8) / 2, y + 28);
      const shop = provaIsWorkCode(code) ? provaShopShort(provaNegozio(op, i)) : '';
      if (shop) {
        ctx.font = '600 9px "DM Sans", system-ui, sans-serif';
        ctx.fillText(shop, x + (dayW - 8) / 2, y + 42);
      }
      const s2 = provaSecond(op, i);
      if (s2 && s2.code) {
        ctx.font = '800 10px "DM Sans", system-ui, sans-serif';
        ctx.fillText(PROVA_LABEL[s2.code] || s2.code, x + (dayW - 8) / 2, y + 56);
        ctx.font = '600 9px "DM Sans", system-ui, sans-serif';
        ctx.fillText(provaShopShort(s2.shop), x + (dayW - 8) / 2, y + 68);
      }
      ctx.textAlign = 'left';
    }
  });
  const by = tableY + headH + OPERATORS.length * rowH;
  ctx.fillStyle = '#2a211c';
  ctx.font = '700 13px "DM Sans", system-ui, sans-serif';
  ctx.fillText('Bagheria', pad + 6, by + 28);
  ctx.fillStyle = '#6f645b';
  ctx.font = '600 11px "DM Sans", system-ui, sans-serif';
  ctx.fillText('Sorrentino', pad + 6, by + 48);
  for (let i = 0; i < 7; i++) {
    const x = pad + nameW + i * dayW + 4;
    const cur = provaBagheriaValue(i);
    const work = cur && cur !== 'L';
    roundRectPath(ctx, x, by + 8, dayW - 8, rowH - 16, 8);
    ctx.fillStyle = work ? '#e0f2fe' : '#f4efe6';
    ctx.fill();
    ctx.fillStyle = work ? '#075985' : '#6f645b';
    ctx.textAlign = 'center';
    ctx.font = '800 11px "DM Sans", system-ui, sans-serif';
    const lab = work ? (PROVA_LABEL[cur] || cur) : 'Libero';
    ctx.fillText(lab, x + (dayW - 8) / 2, by + 40);
    ctx.textAlign = 'left';
  }
  const ly = by + rowH + 18;
  ctx.font = '700 11px "DM Sans", system-ui, sans-serif';
  const chips = [
    { t: 'La Malfa', bg: '#ffedd5', fg: '#9a3412' },
    { t: 'Rizzo', bg: '#dbeafe', fg: '#1d4ed8' },
    { t: 'San Lorenzo', bg: '#dcfce7', fg: '#166534' },
    { t: 'Bagheria', bg: '#e0f2fe', fg: '#075985' }
  ];
  let cx = pad;
  chips.forEach(ch => {
    const w = ctx.measureText(ch.t).width + 20;
    roundRectPath(ctx, cx, ly, w, 22, 6);
    ctx.fillStyle = ch.bg;
    ctx.fill();
    ctx.fillStyle = ch.fg;
    ctx.fillText(ch.t, cx + 10, ly + 15);
    cx += w + 8;
  });
  ctx.fillStyle = '#8a7d74';
  ctx.font = '500 11px "DM Sans", system-ui, sans-serif';
  ctx.fillText('Generata da Pet Store La Malfa  ·  ' + new Date().toLocaleDateString('it-IT'), pad, H - pad);
  return canvas;
}

function closeProvaShare() {
  const el = document.getElementById('prova-share-overlay');
  if (el) el.classList.add('hidden');
}

async function sendProvaShare() {
  if (!provaShareBlob) return;
  const name = 'turni-' + (provaWeekStart || 'settimana') + '.png';
  const file = new File([provaShareBlob], name, { type: 'image/png' });
  try {
    if (navigator.share) {
      if (!navigator.canShare || navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Turni Pet Store La Malfa' });
        return;
      }
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;
  }
  const a = document.createElement('a');
  a.href = provaShareUrl;
  a.download = name;
  a.click();
  showToast('Se il download non parte, tieni premuto l’immagine.', 'warn');
}

async function createTurniProvaImage() {
  const empty = OPERATORS.every(op => {
    for (let i = 0; i < 7; i++) if (provaCell(op, i)) return false;
    return true;
  });
  if (empty) {
    showToast('Prima genera o compila la settimana', 'warn');
    return;
  }
  const canvas = drawTurniProvaCanvas();
  provaShareBlob = await new Promise(res => canvas.toBlob(res, 'image/png'));
  if (!provaShareBlob) {
    showToast('Impossibile creare l’immagine', 'error');
    return;
  }
  if (provaShareUrl) URL.revokeObjectURL(provaShareUrl);
  provaShareUrl = URL.createObjectURL(provaShareBlob);
  const img = document.getElementById('prova-share-img');
  if (img) img.src = provaShareUrl;
  const ov = document.getElementById('prova-share-overlay');
  if (ov) ov.classList.remove('hidden');
}

function provaDraftKey() {
  return 'petstore_turni_bozza_' + (provaWeekStart || provaMondayStr());
}

function provaMakeSnapshot() {
  return {
    celle: JSON.parse(JSON.stringify(provaCelle || {})),
    negozi: JSON.parse(JSON.stringify(provaNegozi || {})),
    slot2: JSON.parse(JSON.stringify(provaSlot2 || {})),
    vincoli: JSON.parse(JSON.stringify(provaVincoli || {})),
    vincoliNegozi: JSON.parse(JSON.stringify(provaVincoliNegozi || {})),
    vincoliBagheria: JSON.parse(JSON.stringify(provaVincoliBagheria || {})),
    vincoliSlot2: JSON.parse(JSON.stringify(provaVincoliSlot2 || {})),
    at: new Date().toISOString(),
    by: currentOperator || ''
  };
}

function provaReadLocalDraft() {
  try {
    const raw = localStorage.getItem(provaDraftKey());
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function provaBestDraft() {
  const local = provaReadLocalDraft();
  const cloud = provaLastBozza;
  if (local && cloud && local.at && cloud.at) {
    return new Date(local.at) >= new Date(cloud.at) ? local : cloud;
  }
  return local || cloud || null;
}

function provaDraftLabel(snap) {
  if (!snap || !snap.at) return '';
  const d = new Date(snap.at);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + (snap.by ? ' · ' + snap.by : '');
}

function updateProvaDraftHint() {
  const el = document.getElementById('prova-draft-hint');
  const snap = provaBestDraft();
  if (!el) return;
  el.textContent = snap
    ? ('Bozza: ' + provaDraftLabel(snap) + '. Tocca Riprendi bozza per recuperarla.')
    : 'Salva bozza mette da parte gli orari senza pubblicare la settimana.';
}

function applyProvaSnapshot(snap) {
  if (!snap) return;
  provaCelle = snap.celle && typeof snap.celle === 'object' ? snap.celle : {};
  provaNegozi = snap.negozi && typeof snap.negozi === 'object' ? snap.negozi : {};
  provaSlot2 = snap.slot2 && typeof snap.slot2 === 'object' ? snap.slot2 : {};
  if (snap.vincoli) provaVincoli = snap.vincoli;
  if (snap.vincoliNegozi) provaVincoliNegozi = snap.vincoliNegozi;
  if (snap.vincoliBagheria) provaVincoliBagheria = snap.vincoliBagheria;
  if (snap.vincoliSlot2) provaVincoliSlot2 = snap.vincoliSlot2;
}

async function saveTurniProvaDraft() {
  if (provaGuardLocked()) return;
  if (!provaWeekStart) provaWeekStart = provaMondayStr();
  const empty = OPERATORS.every(op => {
    for (let i = 0; i < 7; i++) if (provaCell(op, i)) return false;
    return true;
  });
  if (empty) {
    showToast('Non c’è nulla da mettere in bozza', 'warn');
    return;
  }
  const snap = provaMakeSnapshot();
  provaLastBozza = snap;
  try { localStorage.setItem(provaDraftKey(), JSON.stringify(snap)); } catch (e) {}
  if (supabase) {
    const packed = provaPackCelle();
    packed._bozza = snap;
    const { error } = await supabase.from('turni_prova').upsert({
      settimana_inizio: provaWeekStart,
      celle: packed,
      updated_by: currentOperator,
      updated_at: new Date().toISOString()
    }, { onConflict: 'settimana_inizio' });
    if (error && !/does not exist|schema cache|42P01/i.test(error.message || '')) {
      showToast('Bozza sul telefono. Cloud: ' + error.message, 'warn');
      updateProvaDraftHint();
      return;
    }
  }
  updateProvaDraftHint();
  showToast('Bozza salvata. Puoi chiudere e riprendere dopo.', 'success');
}

function restoreTurniProvaDraft() {
  const snap = provaBestDraft();
  if (!snap) {
    showToast('Nessuna bozza per questa settimana', 'warn');
    return;
  }
  applyProvaSnapshot(snap);
  renderTurniProva();
  updateProvaDraftHint();
  showToast('Bozza ripristinata', 'success');
}

async function saveTurniProva() {
  if (provaGuardLocked()) return;
  if (!supabase) {
    showToast('Cloud non disponibile', 'warn');
    return;
  }
  if (!provaWeekStart) provaWeekStart = provaMondayStr();
  const { error } = await supabase.from('turni_prova').upsert({
    settimana_inizio: provaWeekStart,
    celle: provaPackCelle(),
    updated_by: currentOperator,
    updated_at: new Date().toISOString()
  }, { onConflict: 'settimana_inizio' });
  if (error) {
    const msg = (error.message || '') + '';
    if (/does not exist|schema cache|42P01/i.test(msg)) {
      provaTableMissing = true;
      showToast('Crea la tabella: Copia SQL tabella', 'warn');
    } else {
      showToast('Errore: ' + error.message, 'error');
    }
    return;
  }
  showToast('Settimana salvata', 'success');
  loadTurniProva();
  loadMonteOre();
  loadOggiTurniDash();
}

const MONTE_TARGET = 40;
const MONTE_LS = 'petstore_monte_ore';
let monteMovs = [];
let monteAuto = [];
let monteTableMissing = false;

function fmtOreDelta(n) {
  const v = Math.round(Number(n) * 10) / 10;
  if (v > 0) return '+' + String(v).replace('.', ',') + 'h';
  if (v < 0) return String(v).replace('.', ',') + 'h';
  return '0h';
}

function hoursFromPackedCelle(data, op) {
  if (!data || typeof data !== 'object') return 0;
  const celle = data[op] || {};
  const slot2 = (data._slot2 && data._slot2[op]) || {};
  let h = 0;
  for (let i = 0; i < 7; i++) {
    h += PROVA_HOURS[celle[String(i)] || ''] || 0;
    const s2 = slot2[String(i)];
    if (s2 && s2.code) h += PROVA_HOURS[s2.code] || 0;
  }
  return h;
}

function readLocalMonte() {
  try {
    const raw = localStorage.getItem(MONTE_LS);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

function writeLocalMonte(arr) {
  try { localStorage.setItem(MONTE_LS, JSON.stringify(arr)); } catch (e) {}
}

function computeMonteAuto(weeks) {
  const auto = [];
  (weeks || []).forEach(row => {
    const celle = row && row.celle;
    if (!celle || typeof celle !== 'object') return;
    let tot = 0;
    OPERATORS.forEach(op => { tot += hoursFromPackedCelle(celle, op); });
    if (!tot) return;
    OPERATORS.forEach(op => {
      const h = hoursFromPackedCelle(celle, op);
      auto.push({
        tipo: 'turni',
        operatore: op,
        settimana: row.settimana_inizio,
        ore_fatte: h,
        ore: Math.round((h - MONTE_TARGET) * 10) / 10
      });
    });
  });
  return auto;
}

function monteSaldo(op) {
  let s = 0;
  monteAuto.forEach(a => { if (a.operatore === op) s += a.ore; });
  monteMovs.forEach(m => { if (m.operatore === op) s += Number(m.ore) || 0; });
  return Math.round(s * 10) / 10;
}

function fillMonteOpSelect() {
  const sel = document.getElementById('monte-op');
  if (!sel) return;
  const cur = sel.value || currentOperator || OPERATORS[0];
  sel.innerHTML = OPERATORS.map(op => '<option value="' + escapeHtml(op) + '"' + (op === cur ? ' selected' : '') + '>' + escapeHtml(op) + '</option>').join('');
  const d = document.getElementById('monte-data');
  if (d && !d.value) d.value = toDateStr(new Date());
}

let monteEditId = null;

function monteClearForm() {
  monteEditId = null;
  const add = document.getElementById('btn-monte-add');
  if (add) add.textContent = 'Aggiungi rettifica';
  const cancel = document.getElementById('btn-monte-cancel');
  if (cancel) cancel.classList.add('hidden');
  const mot = document.getElementById('monte-motivo');
  const oreEl = document.getElementById('monte-ore');
  if (mot) mot.value = '';
  if (oreEl) oreEl.value = '';
}

function startMonteEdit(id) {
  const m = monteMovs.find(x => String(x.id) === String(id));
  if (!m) return;
  monteEditId = m.id;
  const op = document.getElementById('monte-op');
  const data = document.getElementById('monte-data');
  const segno = document.getElementById('monte-segno');
  const oreEl = document.getElementById('monte-ore');
  const mot = document.getElementById('monte-motivo');
  const ore = Number(m.ore) || 0;
  if (op) op.value = m.operatore;
  if (data) data.value = m.data || '';
  if (segno) segno.value = ore < 0 ? 'meno' : 'piu';
  if (oreEl) oreEl.value = String(Math.abs(ore));
  if (mot) mot.value = m.motivo || '';
  const add = document.getElementById('btn-monte-add');
  if (add) add.textContent = 'Salva modifica';
  const cancel = document.getElementById('btn-monte-cancel');
  if (cancel) cancel.classList.remove('hidden');
  const panel = document.getElementById('monte-ore-panel');
  if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderMonteOre() {
  fillMonteOpSelect();
  const saldi = document.getElementById('monte-saldi');
  const storico = document.getElementById('monte-storico');
  if (saldi) {
    saldi.innerHTML = OPERATORS.map(op => {
      const v = monteSaldo(op);
      const cls = v > 0 ? 'is-plus' : v < 0 ? 'is-minus' : 'is-zero';
      const auto = monteAuto.filter(a => a.operatore === op).reduce((s, a) => s + a.ore, 0);
      const man = monteMovs.filter(m => m.operatore === op).reduce((s, m) => s + (Number(m.ore) || 0), 0);
      return '<div class="monte-saldo"><div><b>' + escapeHtml(op) + '</b><small>turni ' + fmtOreDelta(auto) + ' · manuale ' + fmtOreDelta(man) + '</small></div><span class="monte-val ' + cls + '">' + fmtOreDelta(v) + '</span></div>';
    }).join('');
  }
  if (storico) {
    const items = [];
    monteAuto.forEach(a => {
      if (!a.ore) return;
      const start = a.settimana;
      const end = start ? toDateStr(sundayOf(parseDate(start))) : '';
      items.push({
        t: start || '',
        html: '<div class="monte-item"><div class="monte-item-top"><span>' + escapeHtml(a.operatore) + '</span><span class="monte-val ' + (a.ore > 0 ? 'is-plus' : 'is-minus') + '">' + fmtOreDelta(a.ore) + '</span></div><div class="field-hint">Turni ' + (start ? formatRange(start, end) : '') + ' · ' + a.ore_fatte + 'h su 40</div></div>'
      });
    });
    monteMovs.forEach(m => {
      const ore = Number(m.ore) || 0;
      const mid = escapeHtml(String(m.id || ''));
      items.push({
        t: m.data || m.created_at || '',
        html: '<div class="monte-item"><div class="monte-item-top"><span>' + escapeHtml(m.operatore) + '</span><span class="monte-val ' + (ore > 0 ? 'is-plus' : 'is-minus') + '">' + fmtOreDelta(ore) + '</span></div><div class="field-hint">' + (m.data ? parseDate(m.data).toLocaleDateString('it-IT') : '') + (m.created_by ? ' · ' + escapeHtml(m.created_by) : '') + '</div><div>' + escapeHtml(m.motivo || '') + '</div>' + (m.id ? '<div class="monte-item-actions"><button type="button" class="btn-small" data-monte-edit="' + mid + '">Modifica</button><button type="button" class="btn-small btn-small-danger" data-monte-del="' + mid + '">Elimina</button></div>' : '') + '</div>'
      });
    });
    items.sort((a, b) => (b.t || '').localeCompare(a.t || ''));
    storico.innerHTML = items.length ? items.map(x => x.html).join('') : '<p class="field-hint">Nessun movimento. I turni salvati e le rettifiche compariranno qui.</p>';
    storico.querySelectorAll('[data-monte-edit]').forEach(btn => {
      btn.onclick = () => startMonteEdit(btn.getAttribute('data-monte-edit'));
    });
    storico.querySelectorAll('[data-monte-del]').forEach(btn => {
      btn.onclick = () => deleteMonteRettifica(btn.getAttribute('data-monte-del'));
    });
  }
}

async function loadMonteOre() {
  monteAuto = [];
  monteMovs = readLocalMonte();
  if (supabase) {
    try {
      const weeks = await supabase.from('turni_prova').select('settimana_inizio,celle');
      if (!weeks.error && weeks.data) monteAuto = computeMonteAuto(weeks.data);
      const mov = await supabase.from('monte_ore').select('id,operatore,data,ore,motivo,created_by,created_at').order('data', { ascending: false });
      if (mov.error) {
        const msg = (mov.error.message || '') + '';
        if (/does not exist|schema cache|42P01/i.test(msg)) monteTableMissing = true;
      } else {
        monteTableMissing = false;
        monteMovs = mov.data || [];
      }
    } catch (e) {}
  }
  renderMonteOre();
}

async function addMonteRettifica() {
  const op = (document.getElementById('monte-op') || {}).value;
  const data = (document.getElementById('monte-data') || {}).value;
  const segno = (document.getElementById('monte-segno') || {}).value;
  const raw = parseFloat(String((document.getElementById('monte-ore') || {}).value || '').replace(',', '.'));
  const motivo = ((document.getElementById('monte-motivo') || {}).value || '').trim();
  if (!op) { showToast('Scegli l’operatore', 'warn'); return; }
  if (!data) { showToast('Inserisci la data', 'warn'); return; }
  if (!raw || raw <= 0) { showToast('Inserisci le ore (es. 1 o 1,5)', 'warn'); return; }
  if (!motivo) { showToast('Il motivo è obbligatorio', 'warn'); return; }
  const ore = segno === 'meno' ? -Math.abs(raw) : Math.abs(raw);
  const row = {
    operatore: op,
    data: data,
    ore: ore,
    motivo: motivo,
    created_by: currentOperator,
    created_at: new Date().toISOString()
  };
  if (monteEditId) {
    row.created_by = (monteMovs.find(x => String(x.id) === String(monteEditId)) || {}).created_by || currentOperator;
    if (supabase && !monteTableMissing && String(monteEditId).indexOf('local-') !== 0) {
      const { error } = await supabase.from('monte_ore').update({
        operatore: row.operatore,
        data: row.data,
        ore: row.ore,
        motivo: row.motivo
      }).eq('id', monteEditId);
      if (error) {
        showToast('Errore: ' + error.message, 'error');
        return;
      }
    } else {
      monteMovs = readLocalMonte().map(x => String(x.id) === String(monteEditId) ? Object.assign({}, x, row, { id: monteEditId }) : x);
      writeLocalMonte(monteMovs);
    }
    monteClearForm();
    showToast('Rettifica aggiornata', 'success');
    await loadMonteOre();
    return;
  }
  if (supabase && !monteTableMissing) {
    const { error } = await supabase.from('monte_ore').insert(row);
    if (error) {
      const msg = (error.message || '') + '';
      if (/does not exist|schema cache|42P01/i.test(msg)) {
        monteTableMissing = true;
        showToast('Crea la tabella: Copia SQL tabella', 'warn');
      } else {
        showToast('Errore: ' + error.message, 'error');
        return;
      }
    } else {
      const mot = document.getElementById('monte-motivo');
      const oreEl = document.getElementById('monte-ore');
      if (mot) mot.value = '';
      if (oreEl) oreEl.value = '';
      monteClearForm();
      showToast('Rettifica inserita', 'success');
      await loadMonteOre();
      return;
    }
  }
  row.id = 'local-' + Date.now();
  monteMovs = [row].concat(readLocalMonte());
  writeLocalMonte(monteMovs);
  const mot = document.getElementById('monte-motivo');
  const oreEl = document.getElementById('monte-ore');
  if (mot) mot.value = '';
  if (oreEl) oreEl.value = '';
  monteClearForm();
  showToast(monteTableMissing ? 'Salvata in locale (crea la tabella SQL)' : 'Rettifica inserita', 'success');
  renderMonteOre();
}

async function deleteMonteRettifica(id) {
  if (!id) return;
  if (!confirm('Eliminare questa rettifica dal monte ore?')) return;
  if (supabase && !monteTableMissing && String(id).indexOf('local-') !== 0) {
    const { error } = await supabase.from('monte_ore').delete().eq('id', id);
    if (error) {
      showToast('Errore: ' + error.message, 'error');
      return;
    }
  } else {
    monteMovs = readLocalMonte().filter(x => String(x.id) !== String(id));
    writeLocalMonte(monteMovs);
  }
  if (String(monteEditId) === String(id)) monteClearForm();
  showToast('Rettifica eliminata', 'success');
  await loadMonteOre();
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

function isScanBeepOn() {
  return localStorage.getItem('petstore_scan_beep') !== '0';
}

function setScanBeep(on) {
  localStorage.setItem('petstore_scan_beep', on ? '1' : '0');
  const btnOn = document.getElementById('btn-beep-on');
  const btnOff = document.getElementById('btn-beep-off');
  if (btnOn) btnOn.classList.toggle('active', on);
  if (btnOff) btnOff.classList.toggle('active', !on);
}

function initScanBeep() {
  setScanBeep(isScanBeepOn());
}

function initTheme() {
  applyTheme(getTheme());
  initScanBeep();
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
        : `<div class="mission-card-actions">
            <button class="btn btn-primary mission-check-btn btn-check-mission" data-ean="${ean}">Segna controllato</button>
            <button type="button" class="btn btn-secondary mission-check-btn btn-replace-mission" data-ean="${ean}">Sostituisci</button>
          </div>`
      }
    </div>`;
  }

  listEl.innerHTML =
    (todo.length ? todo.map(ean => missionCard(ean, false)).join('') : (completed ? emptyStateHtml('Missione completa', 'Hai controllato tutti i prodotti della missione di oggi.', 'home', 'Torna in Home') : '')) +
    (doneEans.length ? `<details class="mission-done-fold"><summary>Già fatti (${doneEans.length})</summary>${doneEans.map(ean => missionCard(ean, true)).join('')}</details>` : '');

  wireEmptyActions(listEl);
  listEl.querySelectorAll('.product-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.btn-check-mission') || e.target.closest('.btn-replace-mission')) return;
      openProduct(card.dataset.ean, 'missione');
    });
  });
  listEl.querySelectorAll('.btn-check-mission').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      markProductChecked(btn.dataset.ean);
    };
  });
  listEl.querySelectorAll('.btn-replace-mission').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      replaceMissionProduct(btn.dataset.ean);
    };
  });
}

async function replaceMissionProduct(oldEan) {
  if (!missioneOggi || !currentOperator || !oldEan) return;
  if (isProductCheckedByMe(oldEan)) {
    showToast('Già controllato, non si sostituisce', 'info');
    return;
  }
  const list = Array.isArray(missioneOggi.prodotti) ? [...missioneOggi.prodotti] : [];
  const idx = list.indexOf(oldEan);
  if (idx < 0) return;

  const exclude = new Set(list);
  try {
    if (supabase) {
      const { data: others } = await supabase.from('missioni').select('prodotti').eq('data', todayStr());
      (others || []).forEach(m => {
        const arr = Array.isArray(m.prodotti) ? m.prodotti : [];
        arr.forEach(e => exclude.add(e));
      });
    }
  } catch (e) {}

  let next = pickRandomProducts(1, exclude);
  if (!next.length) next = pickRandomProducts(1, new Set(list));
  if (!next.length) {
    showToast('Nessun altro prodotto senza data disponibile', 'warn');
    return;
  }
  const newEan = next[0];
  list[idx] = newEan;
  missioneOggi.prodotti = list;

  if (supabase && !missioneOggi._localOnly) {
    try {
      let q = supabase.from('missioni').update({ prodotti: list }).eq('data', missioneOggi.data);
      if (currentOperator) q = q.eq('operator', currentOperator);
      const { error } = await q;
      if (error) {
        console.warn('replace mission:', error);
        showToast('Sostituito solo su questo telefono', 'warn');
      } else {
        showToast('Prodotto sostituito', 'success');
      }
    } catch (e) {
      showToast('Sostituito solo su questo telefono', 'warn');
    }
  } else {
    showToast('Prodotto sostituito', 'success');
  }
  renderMissione();
  updateMissioneDash();
}

function updateMissioneMenuBadge(remaining) {
  const b = document.getElementById('missione-menu-count');
  if (!b) return;
  if (!remaining || remaining <= 0) {
    b.classList.add('hidden');
    return;
  }
  b.textContent = String(remaining);
  b.classList.remove('hidden', 'is-zero');
}

function updateMissioneDash() {
  const el = document.getElementById('missione-dash');
  if (!el) return;

  if (!isAfterMissionHour()) {
    el.classList.remove('hidden', 'done');
    el.innerHTML = 'Missione dalle ' + MISSIONE_HOUR + ':00';
    el.onclick = () => showPage('missione');
    updateMissioneMenuBadge(0);
    return;
  }

  if (!missioneOggi || !missioneOggi.prodotti) {
    el.classList.add('hidden');
    updateMissioneMenuBadge(0);
    return;
  }

  const { done, total } = myMissionProgress();
  const remaining = Math.max(0, total - done);
  const completed = myMissionDone() || (total > 0 && remaining === 0);
  el.classList.remove('hidden');
  if (completed) {
    el.classList.add('done');
    el.innerHTML = '<span class="missione-dash-label">Missione di oggi</span><span class="missione-dash-ok">Completata</span>';
    updateMissioneMenuBadge(0);
  } else {
    el.classList.remove('done');
    el.innerHTML = '<div class="missione-dash-row"><div><div class="missione-dash-label">Missione di oggi</div><div class="missione-dash-sub">' + done + ' di ' + total + ' controllati</div></div><span class="missione-remain">' + remaining + '<small>da fare</small></span></div>';
    updateMissioneMenuBadge(remaining);
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
    el.innerHTML = emptyStateHtml(
      'Nessun prodotto fuori assortimento',
      'Quando un articolo è in catalogo ma non è a scaffale, aprilo e usa «Segna come non in negozio».',
      'scanner',
      'Vai allo scanner'
    );
    wireEmptyActions(el);
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
    stato: row.stato === 'consegnato' ? 'consegnato' : (row.stato === 'non_arrivata' ? 'non_arrivata' : 'prevista')
  };
}

function setConsegneFilter(filter) {
  consegneFilter = filter || 'prossime';
  consegneCalDay = '';
  document.querySelectorAll('#consegne-filters .task-filter-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.cfilter === consegneFilter);
  });
}

function consegneMonthStart() {
  if (!consegneCalCursor) {
    const n = new Date();
    consegneCalCursor = new Date(n.getFullYear(), n.getMonth(), 1);
  }
  return consegneCalCursor;
}

function shiftConsegneCal(delta) {
  const s = consegneMonthStart();
  consegneCalCursor = new Date(s.getFullYear(), s.getMonth() + delta, 1);
  renderConsegneCal();
}

function renderConsegneCal() {
  const el = document.getElementById('consegne-cal');
  if (!el) return;
  const start = consegneMonthStart();
  const y = start.getFullYear();
  const m = start.getMonth();
  const first = new Date(y, m, 1);
  const lastD = new Date(y, m + 1, 0).getDate();
  const pad = first.getDay() === 0 ? 6 : first.getDay() - 1;
  const monthKey = y + '-' + String(m + 1).padStart(2, '0');
  const byDay = {};
  consegneList.forEach(c => {
    const d = normalizeConsegnaDate(c.data);
    if (!d || d.slice(0, 7) !== monthKey) return;
    if (!byDay[d]) byDay[d] = [];
    byDay[d].push(c);
  });
  let cells = '';
  for (let i = 0; i < pad; i++) cells += '<div class="cal-empty"></div>';
  for (let day = 1; day <= lastD; day++) {
    const ds = y + '-' + String(m + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
    const items = byDay[ds] || [];
    const today = ds === todayStr();
    const sel = ds === consegneCalDay;
    let dotCls = '';
    if (items.some(c => c.stato === 'non_arrivata')) dotCls = ' is-miss';
    else if (items.length && items.every(c => c.stato === 'consegnato')) dotCls = ' is-done';
    else if (items.length) dotCls = ' is-wait';
    const names = items.slice(0, 2).map(c => (c.fornitore || '').split(/[\s-]/)[0].slice(0, 8)).join(' · ');
    cells += '<button type="button" class="cal-day' + (today ? ' is-today' : '') + (sel ? ' is-on' : '') + (items.length ? ' has' : '') + '" data-day="' + ds + '">' +
      '<span class="cal-n">' + day + '</span>' +
      (items.length ? '<span class="cal-dot' + dotCls + '"></span>' : '') +
      (names ? '<span class="cal-lab">' + escapeHtml(names) + (items.length > 2 ? '+' : '') + '</span>' : '') +
      '</button>';
  }
  el.innerHTML = '<div class="cal-nav"><button type="button" class="turno-zoom-btn" id="btn-cal-prev" aria-label="Mese precedente">‹</button><div class="cal-title">' + MESI[m] + ' ' + y + '</div><button type="button" class="turno-zoom-btn" id="btn-cal-next" aria-label="Mese successivo">›</button></div>' +
    '<div class="cal-week"><span>L</span><span>M</span><span>M</span><span>G</span><span>V</span><span>S</span><span>D</span></div>' +
    '<div class="cal-grid">' + cells + '</div>';
  const prev = document.getElementById('btn-cal-prev');
  const next = document.getElementById('btn-cal-next');
  if (prev) prev.onclick = () => shiftConsegneCal(-1);
  if (next) next.onclick = () => shiftConsegneCal(1);
  el.querySelectorAll('.cal-day').forEach(btn => {
    btn.onclick = () => {
      if (consegneCalDay === btn.dataset.day) {
        consegneCalDay = '';
        consegneFilter = 'prossime';
      } else {
        consegneCalDay = btn.dataset.day;
        consegneFilter = 'giorno';
      }
      document.querySelectorAll('#consegne-filters .task-filter-btn').forEach(b => {
        b.classList.toggle('active', consegneFilter !== 'giorno' && b.dataset.cfilter === consegneFilter);
      });
      renderConsegne();
    };
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
  renderConsegneCal();
  const el = document.getElementById('consegne-list');
  if (!el) return;
  const oggi = todayStr();
  let list = [...consegneList];

  if (consegneFilter === 'giorno' && consegneCalDay) {
    list = list.filter(c => normalizeConsegnaDate(c.data) === consegneCalDay);
  } else if (consegneFilter === 'oggi') {
    list = list.filter(c => normalizeConsegnaDate(c.data) === oggi);
  } else if (consegneFilter === 'prossime') {
    // future + today, not yet delivered
    list = list.filter(c => {
      const d = normalizeConsegnaDate(c.data);
      return d >= oggi && c.stato !== 'consegnato' && c.stato !== 'non_arrivata';
    });
  } else if (consegneFilter === 'storico') {
    list = list.filter(c => {
      const d = normalizeConsegnaDate(c.data);
      return d < oggi || c.stato === 'consegnato' || c.stato === 'non_arrivata';
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
      giorno: ['Nessuna consegna in questo giorno', 'Tocca un altro giorno nel calendario, oppure aggiungi una consegna.', 'new-consegna', 'Nuova consegna'],
      prossime: ['Nessuna consegna in arrivo', 'Non ci sono consegne previste. Aggiungine una per farla comparire in Home il giorno giusto.', 'new-consegna', 'Nuova consegna'],
      oggi: ['Nessuna consegna per oggi', 'Oggi non è prevista nessuna azienda. Puoi registrare una consegna se serve.', 'new-consegna', 'Nuova consegna'],
      storico: ['Storico vuoto', 'Le consegne passate e quelle già ritirate restano qui.', '', ''],
      tutte: ['Nessuna consegna registrata', 'Tutti gli operatori possono inserire una consegna: data, fornitore e stato.', 'new-consegna', 'Nuova consegna']
    };
    const cfg = emptyMsg[consegneFilter] || emptyMsg.tutte;
    el.innerHTML = emptyStateHtml(cfg[0], cfg[1], cfg[2] || null, cfg[3]);
    wireEmptyActions(el);
    return;
  }

  el.innerHTML = list.map(c => {
    const dNorm = normalizeConsegnaDate(c.data);
    const isOggi = dNorm === oggi;
    const st = c.stato === 'consegnato' ? 'consegnato' : (c.stato === 'non_arrivata' ? 'non_arrivata' : 'prevista');
    const d = dNorm ? formatGiornoSafe(dNorm) : '';
    const statoLabel = st === 'consegnato' ? 'Consegnato' : (st === 'non_arrivata' ? 'Non arrivata' : (isOggi ? 'Oggi' : 'In arrivo'));
    const statoClass = st === 'consegnato' ? 'consegnato' : (st === 'non_arrivata' ? 'non_arrivata' : (isOggi ? 'oggi' : 'prevista'));
    return `<div class="consegna-card ${isOggi ? 'oggi' : ''} ${st}" data-id="${c.id}">
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
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const domani = toDateStr(d);
  const oggiList = consegneList.filter(c => normalizeConsegnaDate(c.data) === oggi);
  const domaniList = consegneList.filter(c => normalizeConsegnaDate(c.data) === domani && c.stato !== 'consegnato' && c.stato !== 'non_arrivata');
  if (!oggiList.length && !domaniList.length) {
    el.classList.add('hidden');
    return;
  }
  const pending = oggiList.filter(c => c.stato !== 'consegnato' && c.stato !== 'non_arrivata');
  const missed = oggiList.filter(c => c.stato === 'non_arrivata');
  const done = oggiList.filter(c => c.stato === 'consegnato');
  el.classList.remove('hidden');
  let html = '';
  if (pending.length) {
    html += '<div class="consegne-dash-title">Oggi in arrivo</div>';
    html += pending.map(c => {
      const ora = c.ora ? String(c.ora).slice(0, 5) : '';
      return `<div class="consegne-dash-card">
        <div class="consegne-dash-info">
          <div class="consegne-dash-name">${escapeHtml(c.fornitore || '')}</div>
          <div class="consegne-dash-time">${ora ? 'Previsto · ' + escapeHtml(ora) : 'Orario non indicato'}</div>
        </div>
        <div class="consegne-dash-actions">
          <button type="button" class="btn btn-primary btn-consegna-ok" data-id="${escapeHtml(String(c.id || ''))}">Consegnato</button>
          <button type="button" class="btn btn-secondary btn-consegna-miss" data-id="${escapeHtml(String(c.id || ''))}">Non arrivata</button>
        </div>
      </div>`;
    }).join('');
  } else if (done.length && !missed.length) {
    html += '<div class="consegne-dash-title">Oggi in arrivo</div>';
    html += '<div class="consegne-dash-done-all">Tutte consegnate</div>';
  }
  if (missed.length) {
    html += '<div class="consegne-dash-title">Non arrivate</div>';
    html += missed.map(c => {
      const ora = c.ora ? String(c.ora).slice(0, 5) : '';
      return `<div class="consegne-dash-card is-missed">
        <div class="consegne-dash-info">
          <div class="consegne-dash-name">${escapeHtml(c.fornitore || '')}</div>
          <div class="consegne-dash-time">Non arrivata${ora ? ' · ' + escapeHtml(ora) : ''}</div>
        </div>
        <button type="button" class="btn btn-primary btn-consegna-ok" data-id="${escapeHtml(String(c.id || ''))}">Consegnato</button>
      </div>`;
    }).join('');
  }
  if (done.length) {
    html += done.map(c => {
      const ora = c.ora ? String(c.ora).slice(0, 5) : '';
      return `<div class="consegne-dash-card is-done">
        <div class="consegne-dash-info">
          <div class="consegne-dash-name">${escapeHtml(c.fornitore || '')}</div>
          <div class="consegne-dash-time">Consegnato${ora ? ' · ' + escapeHtml(ora) : ''}</div>
        </div>
      </div>`;
    }).join('');
  }
  if (domaniList.length) {
    html += '<div class="consegne-dash-domani"><span>Domani</span>' +
      domaniList.map(c => {
        const ora = c.ora ? String(c.ora).slice(0, 5) : '';
        return '<strong>' + escapeHtml(c.fornitore || '') + '</strong>' + (ora ? ' · ' + escapeHtml(ora) : '');
      }).join('<br>') + '</div>';
  }
  el.innerHTML = html;
  el.querySelectorAll('.btn-consegna-ok').forEach(btn => {
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      markConsegnaStato(btn.dataset.id, 'consegnato');
    };
  });
  el.querySelectorAll('.btn-consegna-miss').forEach(btn => {
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      markConsegnaStato(btn.dataset.id, 'non_arrivata');
    };
  });
  el.onclick = (e) => {
    if (e.target.closest('.btn-consegna-ok') || e.target.closest('.btn-consegna-miss')) return;
    setConsegneFilter(pending.length || missed.length || oggiList.length ? 'oggi' : 'prossime');
    showPage('consegne');
    renderConsegne();
  };
}

async function markConsegnaStato(id, stato) {
  if (!id) {
    showToast('Consegna senza id, aprila da Consegne', 'warn');
    return;
  }
  if (!supabase) {
    showToast('Cloud non disponibile', 'warn');
    return;
  }
  const c = consegneList.find(x => String(x.id) === String(id));
  if (!c) return;
  const { error } = await supabase.from('consegne').update({
    stato: stato,
    updated_by: currentOperator || 'Sconosciuto',
    updated_at: new Date().toISOString()
  }).eq('id', id);
  if (error) {
    showToast('Errore: ' + error.message, 'error');
    return;
  }
  c.stato = stato;
  showToast((stato === 'consegnato' ? 'Consegnato' : 'Non arrivata') + ' · ' + (c.fornitore || ''), stato === 'consegnato' ? 'success' : 'warn');
  updateConsegneDash();
  const page = document.getElementById('page-consegne');
  if (page && page.classList.contains('active')) renderConsegne();
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
    document.getElementById('consegna-stato').value = (c.stato === 'consegnato' || c.stato === 'non_arrivata') ? c.stato : 'prevista';
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

function setOrdineFilter(filter) {
  const sel = document.getElementById('ordine-filter');
  if (sel) sel.value = filter;
  document.querySelectorAll('[data-ofilter]').forEach(ch => {
    ch.classList.toggle('active', ch.dataset.ofilter === filter);
  });
  renderOrdineTable();
}

function filteredOrdineRows() {
  const f = (document.getElementById('ordine-filter') || {}).value || 'da-ordinare';
  let list = [...ordineRows];
  if (f === 'da-ordinare') list = list.filter(r => (r.ordineQty || 0) > 0);
  else if (f === 'alta') list = list.filter(r => r.priorita === 'ALTA' || (r.ordineQty || 0) > 0 && (r.giacenza === null || r.giacenza <= 0));
  list.sort((a, b) => (b.ordineQty || 0) - (a.ordineQty || 0));
  return list;
}

function updateOrdineSummary() {
  const summary = document.getElementById('ordine-summary');
  const title = document.getElementById('ordine-result-title');
  const daOrd = ordineRows.filter(r => (r.ordineQty || 0) > 0);
  const totPezzi = daOrd.reduce((s, r) => s + (r.unita === 'cartoni' ? (r.ordineQty * r.pzCartone) : r.ordineQty), 0);
  if (title) title.textContent = 'Ordine ' + (ordineMeta.fornitore || '');
  if (summary) {
    summary.textContent = (ordineMeta.periodo ? ordineMeta.periodo + ' · ' : '') +
      daOrd.length + ' riferimenti da ordinare · ~' + totPezzi + ' pezzi totali';
  }
}

function applyOrdineQty(idx, qty) {
  const r = ordineRows[idx];
  if (!r) return;
  r.ordineQty = Math.max(0, parseInt(qty, 10) || 0);
  if (r.unita === 'cartoni') {
    r.ordineCartoni = r.ordineQty;
    r.ordinePezzi = r.ordineQty * r.pzCartone;
  } else {
    r.ordinePezzi = r.ordineQty;
    r.ordineCartoni = r.ordineQty;
  }
  updateOrdineSummary();
}

function renderOrdineTable() {
  const wrap = document.getElementById('ordine-table-wrap');
  if (!wrap) return;
  const f = (document.getElementById('ordine-filter') || {}).value || 'da-ordinare';
  document.querySelectorAll('[data-ofilter]').forEach(ch => {
    ch.classList.toggle('active', ch.dataset.ofilter === f);
  });
  updateOrdineSummary();
  const list = filteredOrdineRows();
  if (!list.length) {
    wrap.innerHTML = emptyStateHtml(
      'Nessuna riga in questo filtro',
      'Prova “Tutti i prodotti” per vedere l’elenco completo dell’analisi.',
      'ordine-tutti',
      'Mostra tutti'
    );
    wireEmptyActions(wrap);
    return;
  }
  wrap.innerHTML = list.map(r => {
    const realIdx = ordineRows.indexOf(r);
    const prio = r.priorita || '';
    const prioCls = prio === 'ALTA' ? 'prio-alta' : prio === 'MEDIA' ? 'prio-media' : (prio ? 'prio-bassa' : '');
    const zero = !(r.ordineQty > 0);
    const unit = r.unita === 'cartoni' ? 'cartoni' : 'pz';
    const vend = (r.venduti !== null && r.venduti !== undefined) ? r.venduti : '—';
    const giac = (r.giacenza !== null && r.giacenza !== undefined) ? r.giacenza : '—';
    return `<article class="ordine-card${zero ? ' is-ok' : ''}" data-idx="${realIdx}">
      <div class="ordine-card-top">
        <div>
          <div class="ordine-card-name">${escapeHtml(r.nome || '')}</div>
          <div class="ordine-card-code">${escapeHtml(r.codice || '')}</div>
        </div>
        ${prio ? `<span class="ordine-prio ${prioCls}">${escapeHtml(prio)}</span>` : ''}
      </div>
      <div class="ordine-card-stats">
        <span><strong>${vend}</strong> venduti</span>
        <span><strong>${giac}</strong> giacenza</span>
        <span><strong>${r.pzCartone || '—'}</strong> pz/ct</span>
      </div>
      <div class="ordine-card-qty">
        <label>Da ordinare</label>
        <input class="ordine-qty" type="number" min="0" step="1" inputmode="numeric" value="${r.ordineQty || 0}" data-idx="${realIdx}">
        <span class="ordine-unit">${unit}</span>
      </div>
    </article>`;
  }).join('');

  wrap.querySelectorAll('input.ordine-qty').forEach(inp => {
    const sync = () => {
      const i = parseInt(inp.dataset.idx, 10);
      applyOrdineQty(i, inp.value);
      const card = inp.closest('.ordine-card');
      if (card) card.classList.toggle('is-ok', !(ordineRows[i] && ordineRows[i].ordineQty > 0));
    };
    inp.onchange = sync;
    inp.oninput = sync;
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

function guardTurniProvaPage() {
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
  try { await loadNotesFromCloud(); } catch (e) { console.error(e); }
  try { applyAccessoriesNoExpiry(); } catch (e) { console.error(e); }
  if (supabase) markSync(true);
  else markSync(false);

  const pc = document.getElementById('products-count');
  if (pc) pc.textContent = products.length;

  // Navigation
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.onclick = () => {
      const page = btn.dataset.page;
      if (!showPage(page)) return;
      runPageEnter(page);
    };
  });

  document.getElementById('btn-go-scanner').onclick = () => {
    if (!showPage('scanner')) return;
  };
  const btnOrdiniDash = document.getElementById('btn-go-ordini-dash');
  if (btnOrdiniDash) btnOrdiniDash.onclick = () => { if (!showPage('ordini')) return; };
  document.getElementById('btn-stop-scanner').onclick = stopScanner;
  const btnStartScanner = document.getElementById('btn-start-scanner');
  if (btnStartScanner) {
    btnStartScanner.onclick = async () => {
      unlockScanFeedback();
      btnStartScanner.classList.add('hidden');
      await startScanner();
    };
  }
  const btnTorch = document.getElementById('btn-torch');
  if (btnTorch) btnTorch.onclick = toggleTorch;
  document.getElementById('btn-back').onclick = () => {
    const dest = detailReturnPage || 'dashboard';
    if (!showPage(dest)) return;
    detailReturnPage = 'dashboard';
    runPageEnter(dest);
  };
  const _btnSettings = document.getElementById('btn-settings');
  if (_btnSettings) _btnSettings.onclick = () => showPage('settings');
  document.getElementById('btn-sync').onclick = manualSync;

  const btnUnsavedSave = document.getElementById('btn-unsaved-save');
  if (btnUnsavedSave) btnUnsavedSave.onclick = saveUnsavedAndLeave;
  const btnUnsavedDiscard = document.getElementById('btn-unsaved-discard');
  if (btnUnsavedDiscard) btnUnsavedDiscard.onclick = discardUnsavedAndLeave;
  const btnUnsavedCancel = document.getElementById('btn-unsaved-cancel');
  if (btnUnsavedCancel) btnUnsavedCancel.onclick = cancelUnsavedLeave;

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
      if (!showPage(page)) return;
      if (page === 'ordini' && !guardOrdiniPage()) return;
      if (page === 'turni-prova' && !guardTurniProvaPage()) return;
      runPageEnter(page);
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
  document.querySelectorAll('[data-ofilter]').forEach(ch => {
    ch.onclick = () => setOrdineFilter(ch.dataset.ofilter);
  });


  const btnThemeLight = document.getElementById('btn-theme-light');
  if (btnThemeLight) btnThemeLight.onclick = () => { applyTheme('light'); showToast('Modalità chiara'); };
  const btnThemeDark = document.getElementById('btn-theme-dark');
  if (btnThemeDark) btnThemeDark.onclick = () => { applyTheme('dark'); showToast('Modalità scura'); };
  const btnBeepOn = document.getElementById('btn-beep-on');
  const btnBeepOff = document.getElementById('btn-beep-off');
  if (btnBeepOn) btnBeepOn.onclick = () => { setScanBeep(true); showToast('Suono scanner acceso', 'success'); };
  if (btnBeepOff) btnBeepOff.onclick = () => { setScanBeep(false); showToast('Suono scanner spento', 'info'); };

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && currentOperator) {
      runSync(true);
    }
  });

  const btnNewSettimana = document.getElementById('btn-new-settimana');
  if (btnNewSettimana) btnNewSettimana.onclick = openNewSettimanaForm;
  const btnProvaPrev = document.getElementById('btn-prova-prev');
  if (btnProvaPrev) btnProvaPrev.onclick = () => shiftProvaWeek(-7);
  const btnProvaNext = document.getElementById('btn-prova-next');
  if (btnProvaNext) btnProvaNext.onclick = () => shiftProvaWeek(7);
  const btnProvaOggi = document.getElementById('btn-prova-oggi');
  if (btnProvaOggi) btnProvaOggi.onclick = () => { provaWeekStart = provaMondayStr(); loadTurniProva(); };
  const provaWeekDate = document.getElementById('prova-week-date');
  if (provaWeekDate) provaWeekDate.onchange = () => setProvaWeekFromDate(provaWeekDate.value, true);
  const provaVincoliWeek = document.getElementById('prova-vincoli-week');
  if (provaVincoliWeek) provaVincoliWeek.onchange = () => setProvaWeekFromDate(provaVincoliWeek.value, false);
  const btnProvaGen = document.getElementById('btn-prova-generate');
  if (btnProvaGen) btnProvaGen.onclick = openProvaVincoli;
  const btnProvaSwap = document.getElementById('btn-prova-swap');
  if (btnProvaSwap) btnProvaSwap.onclick = toggleProvaSwap;
  const btnProvaUnlock = document.getElementById('btn-prova-unlock');
  if (btnProvaUnlock) btnProvaUnlock.onclick = unlockProvaWeek;
  const btnVincoliOk = document.getElementById('btn-prova-vincoli-ok');
  if (btnVincoliOk) btnVincoliOk.onclick = confirmProvaVincoli;
  const btnVincoliSkip = document.getElementById('btn-prova-vincoli-skip');
  if (btnVincoliSkip) btnVincoliSkip.onclick = () => {
    const w = document.getElementById('prova-vincoli-week');
    if (w && w.value) setProvaWeekFromDate(w.value, false);
    provaVincoli = {}; provaVincoliNegozi = {}; provaVincoliBagheria = {}; provaVincoliSlot2 = {};
    closeProvaVincoli();
    generateTurniProva();
  };
  const btnVincoliCancel = document.getElementById('btn-prova-vincoli-cancel');
  if (btnVincoliCancel) btnVincoliCancel.onclick = closeProvaVincoli;
  const btnProvaSave = document.getElementById('btn-prova-save');
  if (btnProvaSave) btnProvaSave.onclick = saveTurniProva;
  const btnProvaDraftSave = document.getElementById('btn-prova-draft-save');
  if (btnProvaDraftSave) btnProvaDraftSave.onclick = saveTurniProvaDraft;
  const btnProvaDraftLoad = document.getElementById('btn-prova-draft-load');
  if (btnProvaDraftLoad) btnProvaDraftLoad.onclick = restoreTurniProvaDraft;
  const btnProvaShare = document.getElementById('btn-prova-share');
  if (btnProvaShare) btnProvaShare.onclick = createTurniProvaImage;
  const btnProvaPrint = document.getElementById('btn-prova-print');
  if (btnProvaPrint) btnProvaPrint.onclick = printTurniProva;
  const btnProvaShareSend = document.getElementById('btn-prova-share-send');
  if (btnProvaShareSend) btnProvaShareSend.onclick = sendProvaShare;
  const btnProvaShareClose = document.getElementById('btn-prova-share-close');
  if (btnProvaShareClose) btnProvaShareClose.onclick = closeProvaShare;
  const btnMonteAdd = document.getElementById('btn-monte-add');
  if (btnMonteAdd) btnMonteAdd.onclick = addMonteRettifica;
  const btnMonteCancel = document.getElementById('btn-monte-cancel');
  if (btnMonteCancel) btnMonteCancel.onclick = monteClearForm;
  const btnCopyProvaSql = document.getElementById('btn-copy-prova-sql');
  if (btnCopyProvaSql) {
    btnCopyProvaSql.onclick = async () => {
      const sql = `create table if not exists turni_prova (
  settimana_inizio date primary key,
  celle jsonb not null default '{}'::jsonb,
  updated_by text,
  updated_at timestamptz not null default now()
);
alter table turni_prova enable row level security;
drop policy if exists turni_prova_all on turni_prova;
create policy turni_prova_all on turni_prova for all using (true) with check (true);

create table if not exists monte_ore (
  id uuid primary key default gen_random_uuid(),
  operatore text not null,
  data date not null,
  ore numeric not null,
  motivo text not null,
  created_by text,
  created_at timestamptz not null default now()
);
alter table monte_ore enable row level security;
drop policy if exists monte_ore_all on monte_ore;
create policy monte_ore_all on monte_ore for all using (true) with check (true);`;
      try {
        await navigator.clipboard.writeText(sql);
        showToast('SQL copiato. Incollalo in Supabase → SQL Editor', 'success');
      } catch (e) {
        showToast('Copia non riuscita', 'error');
      }
    };
  }
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

  // List filter (select nascosto + chip visibili)
  const lfEl = document.getElementById('list-filter');
  if (lfEl) {
    lfEl.addEventListener('change', (e) => {
      renderFilteredList(e.target.value);
    });
  }
  document.querySelectorAll('.list-chip').forEach(ch => {
    ch.onclick = () => setListFilter(ch.dataset.filter);
  });
  const btnExportList = document.getElementById('btn-export-list');
  if (btnExportList) btnExportList.onclick = exportCurrentList;
  const btnPrintList = document.getElementById('btn-print-list');
  if (btnPrintList) btnPrintList.onclick = printCurrentList;
  const listSupplier = document.getElementById('list-supplier');
  if (listSupplier) {
    listSupplier.onchange = () => {
      listSupplier.classList.toggle('is-on', !!listSupplier.value);
      const clr = document.getElementById('btn-clear-supplier');
      if (clr) clr.classList.toggle('hidden', !listSupplier.value);
      renderFilteredList((document.getElementById('list-filter') || {}).value || 'all');
    };
  }
  const btnClearSupplier = document.getElementById('btn-clear-supplier');
  if (btnClearSupplier) {
    btnClearSupplier.onclick = () => {
      const sel = document.getElementById('list-supplier');
      if (sel) sel.value = '';
      if (listSupplier) listSupplier.classList.remove('is-on');
      btnClearSupplier.classList.add('hidden');
      renderFilteredList((document.getElementById('list-filter') || {}).value || 'all');
    };
  }
  const listSearch = document.getElementById('list-search');
  if (listSearch) {
    listSearch.addEventListener('input', () => {
      renderFilteredList((document.getElementById('list-filter') || {}).value || 'all');
    });
  }

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
  const btnCopyLogSql = document.getElementById('btn-copy-log-sql');
  if (btnCopyLogSql) {
    btnCopyLogSql.onclick = async () => {
      try {
        await navigator.clipboard.writeText(SCADENZE_LOG_SQL);
        showToast('SQL copiato. Incollalo in Supabase → SQL Editor', 'success');
      } catch (e) {
        showToast('Copia non riuscita', 'error');
      }
    };
  }
  document.getElementById('import-file').addEventListener('change', (e) => {
    if (e.target.files[0]) importData(e.target.files[0]);
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(console.warn);
  }
}

init().catch(console.error);
