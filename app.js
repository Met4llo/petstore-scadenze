// ===== PetStore Scadenze App + Supabase =====
// VERSION 1.86 - turni prova: aperture/spezzati/chiusure equilibrati
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
create policy turni_prova_all on turni_prova for all using (true) with check (true);`;
const SCADENZE_LOG_SQL = EXTRA_TABLES_SQL;
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
let detailSnapshot = null;
let skipDetailDirty = false;
let pendingDetailLeave = null;
let leaveAfterSave = null;
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
  if ((pageId === 'ordini' || pageId === 'turni-prova') && currentOperator !== 'Santoemma') {
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

function getListForFilter(filter) {
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

  const wanted = getSelectedListSupplier();
  if (wanted) list = list.filter(p => supplierMatches(p, wanted));

  const q = getListSearchQuery();
  if (q.length >= 2) {
    list = list.filter(p => productMatchesListSearch(p, q));
  }

  if (filter === 'all' || filter === 'no-date' || filter === 'no-expiry') {
    list.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'it'));
  } else {
    list.sort((a, b) => (daysRemaining(a.expiry) || 9999) - (daysRemaining(b.expiry) || 9999));
  }
  return list;
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
  const names = [...new Set(products.map(p => (p.supplier || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'it'));
  sel.innerHTML = '<option value="">Tutti i fornitori</option>' +
    '<option value="__none__">Senza fornitore</option>' +
    names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
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

function renderFilteredList(filter) {
  fillListSupplierSelect();
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
      <p class="detail-kicker">Storico modifiche</p>
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
  return d.toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function markLogTableMissing(error) {
  const msg = (error && (error.message || error.code || '')) + '';
  if (/does not exist|schema cache|42P01|scadenze_log/i.test(msg)) {
    scadenzeLogMissing = true;
  }
}

async function writeProductLog(before, after) {
  if (!supabase || scadenzeLogMissing) return;
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
      new_value: b || null
    });
  };
  push('ean', before.ean, after.ean);
  push('expiry', before.expiry, after.expiry);
  push('no_expiry', before.noExpiry ? 'sì' : 'no', after.noExpiry ? 'sì' : 'no');
  push('signaled', before.signaled ? 'sì' : 'no', after.signaled ? 'sì' : 'no');
  push('signaled_date', before.signaledDate, after.signaledDate);
  push('note', before.note, after.note);
  if (!rows.length) return;
  try {
    if (before.ean && after.ean && before.ean !== after.ean) {
      await supabase.from('scadenze_log').update({ ean: after.ean }).eq('ean', before.ean);
    }
    const { error } = await supabase.from('scadenze_log').insert(rows);
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

function renderProductHistory(rows) {
  const el = document.getElementById('product-history');
  if (!el) return;
  if (scadenzeLogMissing) {
    el.innerHTML = '<p class="history-empty">Storico non attivo. In Impostazioni copia e avvia lo SQL della tabella.</p>';
    return;
  }
  if (!rows || !rows.length) {
    el.innerHTML = '<p class="history-empty">Nessuna modifica registrata ancora.</p>';
    return;
  }
  el.innerHTML = rows.map(r => {
    return `<div class="history-item">
      <div class="history-what"><strong>${escapeHtml(formatLogField(r.field))}</strong>
        <span>${escapeHtml(formatLogValue(r.old_value))} → ${escapeHtml(formatLogValue(r.new_value))}</span>
      </div>
      <div class="history-meta">${escapeHtml(r.operator || '')} · ${escapeHtml(formatLogWhen(r.changed_at))}</div>
    </div>`;
  }).join('');
}

async function loadProductHistory(ean) {
  const el = document.getElementById('product-history');
  if (!el || !ean) return;
  if (!supabase) {
    el.innerHTML = '<p class="history-empty">Cloud non disponibile.</p>';
    return;
  }
  if (scadenzeLogMissing) {
    renderProductHistory(null);
    return;
  }
  try {
    const { data, error } = await supabase
      .from('scadenze_log')
      .select('ean,operator,changed_at,field,old_value,new_value')
      .eq('ean', ean)
      .order('changed_at', { ascending: false })
      .limit(5);
    if (error) {
      markLogTableMissing(error);
      renderProductHistory(null);
      return;
    }
    renderProductHistory(data || []);
  } catch (e) {
    markLogTableMissing(e);
    renderProductHistory(null);
  }
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

async function startScanner() {
  if (isScanning) return;
  unlockScanFeedback();
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
    torchOn = false;
    const hasTorch = await detectTorch();
    updateTorchButton(hasTorch);
  } catch (err) {
    console.error(err);
    showToast('Impossibile avviare la fotocamera. Controlla i permessi.', 'error');
  }
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
    const cls = (t.priorita === 'alta' ? 'alta ' : '') + (isDone ? 'fatto' : '');
    const badge = isDone
      ? '<span class="task-badge fatto">Fatto</span>'
      : (t.priorita === 'alta'
        ? '<span class="task-badge alta">Alta</span>'
        : '<span class="task-badge normale">Normale</span>');
    return `<div class="task-card ${cls}" data-id="${t.id}">
      <div class="product-card-top">
        <div class="task-card-title">${escapeHtml(t.titolo)}</div>
        ${badge}
      </div>
      ${t.descrizione ? `<div class="task-card-desc">${escapeHtml(t.descrizione)}</div>` : ''}
      <div class="task-card-meta">
        ${resp ? `<span class="product-supplier">${escapeHtml(resp)}</span>` : ''}
        ${t.created_by ? `<span>${escapeHtml(t.created_by)}</span>` : ''}
        ${date ? `<span>${date}</span>` : ''}
      </div>
      ${!isDone
        ? `<button class="btn btn-primary mission-check-btn btn-complete-task" data-id="${t.id}">Completa</button>
           <button type="button" class="btn-text-back btn-delete-task" data-id="${t.id}">Elimina</button>`
        : `<button type="button" class="btn-text-back btn-delete-task" data-id="${t.id}">Elimina</button>`}
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

function updateTurniDash() {
  // Banner turni rimosso dalla Home (si usano dal menu)
  const el = document.getElementById('turni-dash');
  if (el) el.classList.add('hidden');
}

const PROVA_FASCE = ['', 'A', 'C', 'S', 'DM', 'DS', 'R'];
const PROVA_LABEL = {
  '': '·',
  A: '9-17',
  C: '12-20',
  S: '4+4',
  DM: '9-15',
  DS: '14-20',
  R: 'R'
};
const PROVA_TITLE = {
  '': 'Vuoto',
  A: 'Intero 09:00–17:00 (8h, pausa inclusa)',
  C: 'Intero 12:00–20:00 (8h, pausa inclusa)',
  S: 'Spezzato 09:00–13:00 e 16:00–20:00 (8h)',
  DM: 'Domenica 09:00–15:00 (6h)',
  DS: 'Domenica 14:00–20:00 (6h)',
  R: 'Riposo'
};
const PROVA_HOURS = { '': 0, A: 8, C: 8, S: 8, DM: 6, DS: 6, R: 0 };
const PROVA_SPANS = {
  A: [[9, 17]],
  C: [[12, 20]],
  S: [[9, 13], [16, 20]],
  DM: [[9, 15]],
  DS: [[14, 20]]
};
const PROVA_DAYS = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'];
let provaWeekStart = null;
let provaCelle = {};
let provaTableMissing = false;

function provaMondayStr(d) {
  return toDateStr(mondayOf(d || new Date()));
}

function shiftProvaWeek(days) {
  const cur = parseDate(provaWeekStart || provaMondayStr());
  cur.setDate(cur.getDate() + days);
  provaWeekStart = toDateStr(mondayOf(cur));
  loadTurniProva();
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

function cycleProvaFascia(cur) {
  const i = PROVA_FASCE.indexOf(cur);
  return PROVA_FASCE[(i + 1) % PROVA_FASCE.length];
}

function renderTurniProva() {
  const label = document.getElementById('prova-week-label');
  const grid = document.getElementById('prova-grid');
  if (!provaWeekStart) provaWeekStart = provaMondayStr();
  const start = parseDate(provaWeekStart);
  const end = sundayOf(start);
  if (label) label.textContent = formatRange(provaWeekStart, toDateStr(end));
  if (!grid) return;
  let html = '<table class="prova-table"><thead><tr><th>Ore</th>';
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    html += `<th>${PROVA_DAYS[i]}<small>${d.getDate()}</small></th>`;
  }
  html += '</tr></thead><tbody>';
  OPERATORS.forEach(op => {
    const h = provaHours(op);
    const over = h > 40 ? ' is-over' : '';
    const rc = provaRoleCounts(op);
    html += `<tr><th>${escapeHtml(op)}<small class="prova-ore${over}">${h}h · A${rc.A} S${rc.S} C${rc.C}</small></th>`;
    for (let i = 0; i < 7; i++) {
      const v = provaCell(op, i);
      html += `<td><button type="button" class="prova-cell fascia-${v || 'empty'}" data-op="${escapeHtml(op)}" data-day="${i}" title="${PROVA_TITLE[v] || 'Vuoto'}">${PROVA_LABEL[v] || '·'}</button></td>`;
    }
    html += '</tr>';
  });
  html += '</tbody></table>';
  grid.innerHTML = html;
  grid.querySelectorAll('.prova-cell').forEach(btn => {
    btn.onclick = () => {
      const op = btn.dataset.op;
      const day = parseInt(btn.dataset.day, 10);
      const next = cycleProvaFascia(provaCell(op, day));
      setProvaCell(op, day, next);
      renderTurniProva();
    };
  });
  renderProvaCheck();
}

function provaHours(op) {
  let h = 0;
  for (let i = 0; i < 7; i++) h += PROVA_HOURS[provaCell(op, i)] || 0;
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
  });
  for (let day = 0; day < 7; day++) {
    const name = PROVA_DAYS[day];
    const codes = OPERATORS.map(op => provaCell(op, day));
    if (day === 6) {
      const dm = codes.filter(c => c === 'DM').length;
      const ds = codes.filter(c => c === 'DS').length;
      const work = codes.filter(c => c && c !== 'R').length;
      if (dm !== 1 || ds !== 1 || work !== 2) {
        issues.push('Domenica: 2 persone, una 09-15 e una 14-20');
      }
    } else {
      const atOpen = OPERATORS.filter(op => provaPresent(provaCell(op, day), 9)).length;
      const atClose = OPERATORS.filter(op => provaPresent(provaCell(op, day), 19)).length;
      if (atOpen < 1) issues.push(name + ': nessuno in apertura (09:00)');
      if (atClose < 2) issues.push(name + ': in chiusura ' + atClose + ' persone (min 2)');
      for (let h = 9; h < 20; h++) {
        const n = OPERATORS.filter(op => provaPresent(provaCell(op, day), h)).length;
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
    el.innerHTML = 'Regole ok: chiusura ≥2, max 8h/turno, max 40h, domenica 2. Turni spalmati su aperture / spezzati / chiusure.';
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
  if (code === 'A' || code === 'DM') return 'A';
  if (code === 'C' || code === 'DS') return 'C';
  if (code === 'S') return 'S';
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
    s += (max - min) * 20;
    vals.forEach(v => { s += v * v; });
  });
  return s;
}

function generateTurniProva() {
  if (!provaWeekStart) provaWeekStart = provaMondayStr();
  const ops = OPERATORS.slice();
  const w = provaWeekNumber(provaWeekStart);
  const pairs = [[0, 1], [2, 3], [0, 2], [1, 3], [0, 3], [1, 2]];
  const pair = pairs[((w % 6) + 6) % 6];
  let dm = ops[pair[0]];
  let ds = ops[pair[1]];
  if (w % 2) { const t = dm; dm = ds; ds = t; }

  provaCelle = {};
  ops.forEach(op => { provaCelle[op] = {}; });
  ops.forEach(op => setProvaCell(op, 6, 'R'));
  setProvaCell(dm, 6, 'DM');
  setProvaCell(ds, 6, 'DS');

  const sundayWorkers = new Set([dm, ds]);
  const restLeft = {};
  ops.forEach(op => { restLeft[op] = sundayWorkers.has(op) ? 2 : 1; });

  const counts = {};
  ops.forEach(op => { counts[op] = { A: 0, S: 0, C: 0 }; });
  counts[dm].A += 1;
  counts[ds].C += 1;

  const templates = [
    ['A', 'C', 'C'],
    ['S', 'A', 'C'],
    ['S', 'C', 'C']
  ];

  for (let day = 0; day < 6; day++) {
    const candidates = ops.filter(op => restLeft[op] > 0);
    candidates.sort((a, b) => {
      if (restLeft[b] !== restLeft[a]) return restLeft[b] - restLeft[a];
      return ((ops.indexOf(a) + w + day) % 4) - ((ops.indexOf(b) + w + day) % 4);
    });
    const rest = candidates[0];
    restLeft[rest]--;
    const working = ops.filter(op => op !== rest);

    let bestScore = Infinity;
    let bestRoles = null;
    templates.forEach(tpl => {
      provaUniquePerms(tpl).forEach(roles => {
        const next = {};
        ops.forEach(op => { next[op] = { A: counts[op].A, S: counts[op].S, C: counts[op].C }; });
        working.forEach((op, i) => { next[op][roles[i]] += 1; });
        const sc = provaFairScore(next);
        if (sc < bestScore) {
          bestScore = sc;
          bestRoles = roles.slice();
        }
      });
    });

    ops.forEach(op => setProvaCell(op, day, 'R'));
    working.forEach((op, i) => {
      const role = bestRoles[i];
      setProvaCell(op, day, role);
      counts[op][role] += 1;
    });
  }
  renderTurniProva();
  showToast('Settimana generata, turni equilibrati. Controlla e Salva.', 'success');
}

async function loadTurniProva() {
  if (!isSantoemma()) return;
  if (!provaWeekStart) provaWeekStart = provaMondayStr();
  renderTurniProva();
  const st = document.getElementById('prova-status');
  if (!supabase) {
    if (st) st.textContent = 'Cloud non disponibile — solo su questo telefono.';
    return;
  }
  if (provaTableMissing) {
    if (st) st.textContent = 'Tabella mancante: premi Copia SQL tabella e avviala su Supabase.';
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
      return;
    }
    const row = data && data[0];
    provaCelle = (row && row.celle && typeof row.celle === 'object') ? row.celle : {};
    renderTurniProva();
    if (st) {
      st.textContent = row && row.updated_by
        ? ('Ultimo salvataggio: ' + row.updated_by + (row.updated_at ? ' · ' + new Date(row.updated_at).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''))
        : 'Settimana vuota. Tocca le celle e poi Salva.';
    }
  } catch (e) {
    if (st) st.textContent = 'Errore di rete';
  }
}

async function saveTurniProva() {
  if (!isSantoemma()) return;
  if (!supabase) {
    showToast('Cloud non disponibile', 'warn');
    return;
  }
  if (!provaWeekStart) provaWeekStart = provaMondayStr();
  const { error } = await supabase.from('turni_prova').upsert({
    settimana_inizio: provaWeekStart,
    celle: provaCelle,
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
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const domani = toDateStr(d);
  const oggiList = consegneList.filter(c => normalizeConsegnaDate(c.data) === oggi);
  const domaniList = consegneList.filter(c => normalizeConsegnaDate(c.data) === domani && c.stato !== 'consegnato');
  if (!oggiList.length && !domaniList.length) {
    el.classList.add('hidden');
    return;
  }
  const pending = oggiList.filter(c => c.stato !== 'consegnato');
  const done = oggiList.filter(c => c.stato === 'consegnato');
  el.classList.remove('hidden');
  let html = '';
  if (pending.length) {
    html += '<div class="consegne-dash-title">Oggi in arrivo</div>';
    html += pending.map(c => {
      return `<div class="consegne-dash-row">
        <span class="consegne-dash-name">${escapeHtml(c.fornitore || '')}${c.ora ? ' · ' + escapeHtml(String(c.ora).slice(0, 5)) : ''}</span>
        <button type="button" class="btn btn-primary btn-consegna-ok" data-id="${escapeHtml(String(c.id || ''))}">Consegnato</button>
      </div>`;
    }).join('');
    if (done.length) {
      html += '<div class="consegne-dash-sub">' + done.length + ' già consegnat' + (done.length === 1 ? 'a' : 'e') + '</div>';
    }
  } else if (oggiList.length) {
    html += '<div>Consegne di oggi: tutte segnate come consegnate</div>';
  }
  if (domaniList.length) {
    html += '<div class="consegne-dash-sub">Domani: <strong>' + escapeHtml(domaniList.map(c => c.fornitore).join(', ')) + '</strong></div>';
  }
  el.innerHTML = html;
  el.querySelectorAll('.btn-consegna-ok').forEach(btn => {
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      markConsegnaDone(btn.dataset.id);
    };
  });
  el.onclick = (e) => {
    if (e.target.closest('.btn-consegna-ok')) return;
    setConsegneFilter(pending.length || oggiList.length ? 'oggi' : 'prossime');
    showPage('consegne');
    renderConsegne();
  };
}

async function markConsegnaDone(id) {
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
    stato: 'consegnato',
    updated_by: currentOperator || 'Sconosciuto',
    updated_at: new Date().toISOString()
  }).eq('id', id);
  if (error) {
    showToast('Errore: ' + error.message, 'error');
    return;
  }
  c.stato = 'consegnato';
  showToast('Consegnato · ' + (c.fornitore || ''), 'success');
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
  return guardOrdiniPage();
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
  const btnProvaGen = document.getElementById('btn-prova-generate');
  if (btnProvaGen) btnProvaGen.onclick = generateTurniProva;
  const btnProvaSave = document.getElementById('btn-prova-save');
  if (btnProvaSave) btnProvaSave.onclick = saveTurniProva;
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
create policy turni_prova_all on turni_prova for all using (true) with check (true);`;
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
  const listSupplier = document.getElementById('list-supplier');
  if (listSupplier) {
    listSupplier.onchange = () => {
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
