// Minimal static app to render pricing table and calculator

const DATA_FILES = [
  'anthropic-pricing.json',
  'google-pricing.json',
  'openai-pricing.json',
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
  if(!tbody) return;
  tbody.innerHTML = '';
  const frag = document.createDocumentFragment();
  const state = window.__state;
  if(!state) return;
  const tokens = state.globalTokens || { in: 0, cached: 0, out: 0 };
  for(const r of rows){
    const tr = document.createElement('tr');
    const key = `${r.provider}::${r.model_id || r.model_name}`;
    tr.dataset.key = key;
    const std = calcCostWithCached(tokens, r, false, state.cacheFactor);
    const bat = calcCostWithCached(tokens, r, true, state.cacheFactor);
    const fmt = v => v==null ? '—' : `$${v.toFixed(v>=10?2:3)}`;
    tr.innerHTML = `
      <td>${r.provider}</td>
      <td>${r.model_name}</td>
      <td class="price">${fmtPrice(r.input)}</td>
      <td class="price">${fmtPrice(r.output)}</td>
      <td class="price batch-col">${fmtPrice(r.batch_input)}</td>
      <td class="price batch-col">${fmtPrice(r.batch_output)}</td>
      <td>${fmtContext(r.context_length)}</td>
      <td><span class="avail ${r.availability==='production'?'prod':''}">${r.availability}</span></td>
      <td class="cost std-cost">${fmt(std)}</td>
      <td class="cost batch-cost batch-col">${fmt(bat)}</td>
    `;
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
  const rowCountEl = document.getElementById('rowCount');
  if(rowCountEl) {
    rowCountEl.textContent = `${rows.length} model${rows.length===1?'':'s'}`;
  }
}

function applyFilterSort(state){
  if(!state || !state.data) {
    console.error('applyFilterSort: invalid state');
    return;
  }
  let rows = state.data;
  const key = state.sort.key;
  if(key){
    const dir = state.sort.dir;
    const getCost = (m, batch) => {
      const tokens = state.globalTokens || {in:0, cached:0, out:0};
      return calcCostWithCached(tokens, m, batch, state.cacheFactor) ?? Number.POSITIVE_INFINITY;
    };
    const cmp = (a,b) => {
      if(key === 'std_cost'){
        return getCost(a,false) - getCost(b,false);
      }
      if(key === 'batch_cost'){
        return getCost(a,true) - getCost(b,true);
      }
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
  const inputTokensEl = document.getElementById('inputTokens');
  const cachedTokensEl = document.getElementById('cachedTokens');
  const outputTokensEl = document.getElementById('outputTokens');
  const table = document.getElementById('priceTable');

  if(!inputTokensEl || !cachedTokensEl || !outputTokensEl) {
    console.error('Input elements not found');
    return {};
  }

  const updateGlobalTokens = () => {
    if(!state) return;
    state.globalTokens = {
      in: Number(inputTokensEl.value || 0),
      cached: Number(cachedTokensEl.value || 0),
      out: Number(outputTokensEl.value || 0),
    };
    recalcAllRows(state);
  };

  inputTokensEl.addEventListener('input', updateGlobalTokens);
  inputTokensEl.addEventListener('change', updateGlobalTokens);
  cachedTokensEl.addEventListener('input', updateGlobalTokens);
  cachedTokensEl.addEventListener('change', updateGlobalTokens);
  outputTokensEl.addEventListener('input', updateGlobalTokens);
  outputTokensEl.addEventListener('change', updateGlobalTokens);

  return {};
}


function recalcAllRows(state){
  const tbody = document.getElementById('tableBody');
  if(!tbody || !state || !state.data) return;
  const modelByKey = new Map();
  for(const m of state.data){
    const key = `${m.provider}::${m.model_id || m.model_name}`;
    modelByKey.set(key, m);
  }
  const tokens = state.globalTokens || { in: 0, cached: 0, out: 0 };
  tbody.querySelectorAll('tr').forEach(tr => {
    const key = tr.dataset.key;
    const m = modelByKey.get(key);
    if(!m) return;
    const stdCell = tr.querySelector('.std-cost');
    const batchCell = tr.querySelector('.batch-cost');
    if(!stdCell || !batchCell) return;
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
    sort: { key: 'provider', dir: 'asc' },
    globalTokens: { in: 0, cached: 0, out: 0 },
    cacheFactor: 0.5,
  };
  window.__state = state;
  // Surface unexpected JS errors in footer for easier debugging
  window.addEventListener('error', (e) => {
    const status = document.getElementById('dataStatus');
    if(status) status.textContent = `Error: ${e.message}`;
    console.error('Global error:', e);
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
    if(status) status.textContent = `Loaded ${deduped.length} models`;

    const table = document.getElementById('priceTable');
    if(table) {
      // default hide batch if none of the rows have it
      const anyBatch = deduped.some(d => d.batch_input != null || d.batch_output != null);
      table.classList.toggle('hide-batch', !anyBatch);
    }

    setupUI(state);
    setupSort(state);
    applyFilterSort(state);
  }catch(err){
    console.error(err);
    if(status) status.textContent = `Failed to load data: ${err.message}`;
  }
}

// Ensure DOM is ready before running
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}
