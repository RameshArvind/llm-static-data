// Minimal static app to render pricing table and calculator

const DATA_FILES = [
  'anthropic-pricing.json',
  'google-pricing.json', // empty by default to avoid duplicates
];

async function fetchJsonAny(path){
  const res = await fetch(path);
  if(!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  const text = await res.text();
  try { return JSON.parse(text); } catch(e){ throw new Error(`Invalid JSON in ${path}`); }
}

function normalize(rec){
  const std = (rec.pricing && rec.pricing.standard) || {};
  const batch = (rec.pricing && rec.pricing.batch) || {};
  const val = p => (p && typeof p.price_per_million_tokens === 'number') ? p.price_per_million_tokens : null;
  return {
    provider: rec.provider || 'Unknown',
    model_id: rec.model_id || '',
    model_name: rec.model_name || rec.model_id || 'Unknown',
    context_length: rec.context_length || null,
    availability: rec.availability || 'unknown',
    input: val(std.input),
    output: val(std.output),
    batch_input: val(batch.input),
    batch_output: val(batch.output),
    currency: (std.input && std.input.currency) || (std.output && std.output.currency) || 'USD',
    raw: rec,
  };
}

function fmtPrice(n){
  if(n == null) return '—';
  const s = n >= 100 ? n.toFixed(0) : (n >= 10 ? n.toFixed(2) : n.toFixed(3));
  return `$${s}`;
}

function fmtContext(n){
  if(!n) return '—';
  return Intl.NumberFormat().format(n);
}

function calcCost(tokensIn, tokensOut, m, useBatch){
  const inPrice = useBatch ? m.batch_input : m.input;
  const outPrice = useBatch ? m.batch_output : m.output;
  if(inPrice == null && outPrice == null) return null;
  const pin = inPrice ? (tokensIn/1e6) * inPrice : 0;
  const pout = outPrice ? (tokensOut/1e6) * outPrice : 0;
  return pin + pout;
}

function calcCostWithCached(tokens, m, useBatch, cacheFactor){
  const inPrice = useBatch ? m.batch_input : m.input;
  const outPrice = useBatch ? m.batch_output : m.output;
  if(inPrice == null && outPrice == null) return null;
  const pin = inPrice ? (tokens.in/1e6) * inPrice : 0;
  const pcached = inPrice ? (tokens.cached/1e6) * inPrice * (cacheFactor ?? 0.5) : 0;
  const pout = outPrice ? (tokens.out/1e6) * outPrice : 0;
  return pin + pcached + pout;
}

function renderRows(rows){
  const tbody = document.getElementById('tableBody');
  tbody.innerHTML = '';
  const frag = document.createDocumentFragment();
  for(const r of rows){
    const tr = document.createElement('tr');
    const key = `${r.provider}::${r.model_id || r.model_name}`;
    tr.dataset.key = key;
    const tokens = window.__state && window.__state.inputs[key] || { in: 0, cached: 0, out: 0 };
    tr.innerHTML = `
      <td>${r.provider}</td>
      <td>${r.model_name}</td>
      <td class="price">${fmtPrice(r.input)}</td>
      <td class="price">${fmtPrice(r.output)}</td>
      <td class="price batch-col">${fmtPrice(r.batch_input)}</td>
      <td class="price batch-col">${fmtPrice(r.batch_output)}</td>
      <td>${fmtContext(r.context_length)}</td>
      <td><span class="avail ${r.availability==='production'?'prod':''}">${r.availability}</span></td>
      <td><input type="number" min="0" step="1" class="tok tok-in" value="${tokens.in}"></td>
      <td><input type="number" min="0" step="1" class="tok tok-cached" value="${tokens.cached}"></td>
      <td><input type="number" min="0" step="1" class="tok tok-out" value="${tokens.out}"></td>
      <td class="cost std-cost">—</td>
      <td class="cost batch-cost batch-col">—</td>
    `;
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
  document.getElementById('rowCount').textContent = `${rows.length} model${rows.length===1?'':'s'}`;
  wireRowInputs();
}

function applyFilterSort(state){
  const q = state.query.toLowerCase().trim();
  let rows = state.data;
  if(q){
    rows = rows.filter(r => `${r.provider} ${r.model_name} ${r.model_id}`.toLowerCase().includes(q));
  }
  const key = state.sort.key;
  if(key){
    const dir = state.sort.dir;
    const cmp = (a,b) => {
      const av = a[key];
      const bv = b[key];
      if(av == null && bv == null) return 0;
      if(av == null) return 1;
      if(bv == null) return -1;
      if(typeof av === 'number' && typeof bv === 'number') return av - bv;
      return String(av).localeCompare(String(bv));
    };
    rows = rows.slice().sort((a,b) => dir==='asc' ? cmp(a,b) : -cmp(a,b));
  }
  renderRows(rows);
}

function setupSort(state){
  const thead = document.querySelector('#priceTable thead');
  thead.addEventListener('click', (e) => {
    const th = e.target.closest('th');
    if(!th) return;
    const key = th.getAttribute('data-sort');
    if(!key) return;
    if(state.sort.key === key){
      state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
    } else {
      state.sort.key = key;
      state.sort.dir = key === 'provider' || key === 'model_name' ? 'asc' : 'asc';
    }
    applyFilterSort(state);
  });
}

function setupUI(state){
  const search = document.getElementById('search');
  const reset = document.getElementById('reset');
  const showBatch = document.getElementById('showBatch');
  const table = document.getElementById('priceTable');
  const cacheFactorEl = document.getElementById('cacheFactor');

  search.addEventListener('input', () => { state.query = search.value; applyFilterSort(state); });
  reset.addEventListener('click', () => { search.value=''; state.query=''; applyFilterSort(state); });
  showBatch.addEventListener('change', () => {
    table.classList.toggle('hide-batch', !showBatch.checked);
  });
  cacheFactorEl.addEventListener('input', () => {
    const v = Number(cacheFactorEl.value);
    state.cacheFactor = isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5;
    cacheFactorEl.value = String(state.cacheFactor.toFixed(2));
    recalcAllRows(state);
  });

  // Model select + calculator
  const select = document.getElementById('modelSelect');
  const inEl = document.getElementById('inputTokens');
  const outEl = document.getElementById('outputTokens');
  const costStd = document.getElementById('costStandard');
  const costBatch = document.getElementById('costBatch');

  function populateSelect(){
    select.innerHTML = '';
    state.data.forEach((m, idx) => {
      const opt = document.createElement('option');
      opt.value = String(idx);
      opt.textContent = `${m.provider} – ${m.model_name}`;
      select.appendChild(opt);
    });
  }

  function updateCalc(){
    const idx = Number(select.value || 0) || 0;
    const m = state.data[idx];
    const tin = Number(inEl.value || 0);
    const tout = Number(outEl.value || 0);
    if(!m){ costStd.textContent = 'Standard: —'; costBatch.textContent='Batch: —'; return; }
    const c1 = calcCost(tin, tout, m, false);
    const c2 = calcCost(tin, tout, m, true);
    const fmt = v => v==null ? '—' : `$${v.toFixed(v>=10?2:3)}`;
    costStd.textContent = `Standard: ${fmt(c1)}`;
    costBatch.textContent = `Batch: ${fmt(c2)}`;
  }

  select.addEventListener('change', updateCalc);
  inEl.addEventListener('input', updateCalc);
  outEl.addEventListener('input', updateCalc);

  return { populateSelect, updateCalc };
}

function wireRowInputs(){
  const tbody = document.getElementById('tableBody');
  const state = window.__state;
  const updateRow = (tr, model) => {
    const key = tr.dataset.key;
    const inEl = tr.querySelector('.tok-in');
    const cachedEl = tr.querySelector('.tok-cached');
    const outEl = tr.querySelector('.tok-out');
    const stdCell = tr.querySelector('.std-cost');
    const batchCell = tr.querySelector('.batch-cost');
    const tokens = {
      in: Number(inEl.value || 0),
      cached: Number(cachedEl.value || 0),
      out: Number(outEl.value || 0),
    };
    state.inputs[key] = tokens;
    const std = calcCostWithCached(tokens, model, false, state.cacheFactor);
    const bat = calcCostWithCached(tokens, model, true, state.cacheFactor);
    const fmt = v => v==null ? '—' : `$${v.toFixed(v>=10?2:3)}`;
    stdCell.textContent = fmt(std);
    batchCell.textContent = fmt(bat);
  };

  // Build a quick lookup from key -> model
  const modelByKey = new Map();
  for(const m of state.data){
    const key = `${m.provider}::${m.model_id || m.model_name}`;
    modelByKey.set(key, m);
  }

  tbody.querySelectorAll('tr').forEach(tr => {
    const key = tr.dataset.key;
    const model = modelByKey.get(key);
    if(!model) return;
    const inputs = tr.querySelectorAll('input.tok');
    inputs.forEach(inp => inp.addEventListener('input', () => updateRow(tr, model)));
    // initial compute
    updateRow(tr, model);
  });
}

function setupDelegatedRowInputs(state){
  const tbody = document.getElementById('tableBody');
  if(tbody.dataset.delegated === '1') return;
  tbody.dataset.delegated = '1';
  tbody.addEventListener('input', (e) => {
    const target = e.target;
    if(!target.classList || !target.classList.contains('tok')) return;
    const tr = target.closest('tr');
    const key = tr?.dataset?.key;
    if(!key) return;
    const m = window.__state.data.find(x => `${x.provider}::${x.model_id || x.model_name}` === key);
    if(!m) return;
    // Reuse the same logic as recalcAllRows but for a single row
    const inEl = tr.querySelector('.tok-in');
    const cachedEl = tr.querySelector('.tok-cached');
    const outEl = tr.querySelector('.tok-out');
    const stdCell = tr.querySelector('.std-cost');
    const batchCell = tr.querySelector('.batch-cost');
    const tokens = {
      in: Number(inEl.value || 0),
      cached: Number(cachedEl.value || 0),
      out: Number(outEl.value || 0),
    };
    window.__state.inputs[key] = tokens;
    const std = calcCostWithCached(tokens, m, false, window.__state.cacheFactor);
    const bat = calcCostWithCached(tokens, m, true, window.__state.cacheFactor);
    const fmt = v => v==null ? '—' : `$${v.toFixed(v>=10?2:3)}`;
    stdCell.textContent = fmt(std);
    batchCell.textContent = fmt(bat);
  });
}

function recalcAllRows(state){
  const tbody = document.getElementById('tableBody');
  const modelByKey = new Map();
  for(const m of state.data){
    const key = `${m.provider}::${m.model_id || m.model_name}`;
    modelByKey.set(key, m);
  }
  tbody.querySelectorAll('tr').forEach(tr => {
    const key = tr.dataset.key;
    const m = modelByKey.get(key);
    if(!m) return;
    const inEl = tr.querySelector('.tok-in');
    const cachedEl = tr.querySelector('.tok-cached');
    const outEl = tr.querySelector('.tok-out');
    const stdCell = tr.querySelector('.std-cost');
    const batchCell = tr.querySelector('.batch-cost');
    const tokens = {
      in: Number(inEl.value || 0),
      cached: Number(cachedEl.value || 0),
      out: Number(outEl.value || 0),
    };
    const std = calcCostWithCached(tokens, m, false, state.cacheFactor);
    const bat = calcCostWithCached(tokens, m, true, state.cacheFactor);
    const fmt = v => v==null ? '—' : `$${v.toFixed(v>=10?2:3)}`;
    stdCell.textContent = fmt(std);
    batchCell.textContent = fmt(bat);
  });
}

async function main(){
  const state = {
    data: [],
    query: '',
    sort: { key: 'provider', dir: 'asc' },
    inputs: {}, // key -> {in, cached, out}
    cacheFactor: 0.5,
  };
  window.__state = state;
  // Surface unexpected JS errors in footer for easier debugging
  window.addEventListener('error', (e) => {
    const status = document.getElementById('dataStatus');
    if(status) status.textContent = `Error: ${e.message}`;
  });
  const status = document.getElementById('dataStatus');
  try{
    const results = await Promise.allSettled(DATA_FILES.map(fetchJsonAny));
    const arrays = results.filter(r => r.status==='fulfilled').map(r => r.value);
    const merged = arrays.flat();
    // dedupe by provider+model_id
    const seen = new Set();
    const deduped = [];
    for(const rec of merged){
      const key = `${rec.provider || ''}::${rec.model_id || rec.model_name}`;
      if(seen.has(key)) continue;
      seen.add(key);
      deduped.push(normalize(rec));
    }
    state.data = deduped;
    status.textContent = `Loaded ${deduped.length} models`;

    const table = document.getElementById('priceTable');
    // default hide batch if none of the rows have it
    const anyBatch = deduped.some(d => d.batch_input != null || d.batch_output != null);
    table.classList.toggle('hide-batch', !anyBatch);

    const ui = setupUI(state);
    setupSort(state);
    applyFilterSort(state);
    // Ensure delegated listeners exist and initial compute runs
    setupDelegatedRowInputs(state);
    ui.populateSelect();
    ui.updateCalc();
  }catch(err){
    console.error(err);
    status.textContent = `Failed to load data: ${err.message}`;
  }
}

main();
