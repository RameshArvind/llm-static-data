// Minimal static app to render pricing table and calculator

const DATA_FILES = [
  'anthropic-pricing.json',
  'bedrock-pricing.json',
  'google-pricing.json',
  'openai-pricing.json',
  'deepseek-pricing.json',
];

async function fetchJsonAny(path){
  const res = await fetch(path);
  if(!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  const text = await res.text();
  try { return JSON.parse(text); } catch(e){ throw new Error(`Invalid JSON in ${path}`); }
}

function isAudioOrEmbeddingOnly(rec){
  const modelId = (rec.model_id || '').toLowerCase();
  const modelName = (rec.model_name || '').toLowerCase();
  // Check for audio-only models
  if(modelId.includes('audio') || modelName.includes('audio')){
    return true;
  }
  // Check for embedding-only models
  if(modelId.includes('embedding') || modelName.includes('embedding')){
    return true;
  }
  return false;
}

function normalize(rec){
  const std = (rec.pricing && rec.pricing.standard) || {};
  const batch = (rec.pricing && rec.pricing.batch) || {};
  const val = p => (p && typeof p.price_per_million_tokens === 'number') ? p.price_per_million_tokens : null;
  const isFiltered = isAudioOrEmbeddingOnly(rec);
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
    is_filtered: isFiltered,
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
  let inPrice, outPrice;
  if(useBatch){
    // If batch pricing is not available, fallback to standard pricing
    inPrice = m.batch_input != null ? m.batch_input : m.input;
    outPrice = m.batch_output != null ? m.batch_output : m.output;
  } else {
    inPrice = m.input;
    outPrice = m.output;
  }
  if(inPrice == null && outPrice == null) return null;
  const pin = inPrice ? (tokensIn/1e6) * inPrice : 0;
  const pout = outPrice ? (tokensOut/1e6) * outPrice : 0;
  return pin + pout;
}

function calcCostWithCached(tokens, m, useBatch, cacheFactor){
  let inPrice, outPrice;
  if(useBatch){
    // If batch pricing is not available, fallback to standard pricing
    inPrice = m.batch_input != null ? m.batch_input : m.input;
    outPrice = m.batch_output != null ? m.batch_output : m.output;
  } else {
    inPrice = m.input;
    outPrice = m.output;
  }
  if(inPrice == null && outPrice == null) return null;
  const pin = inPrice ? (tokens.in/1e6) * inPrice : 0;
  const pcached = inPrice ? (tokens.cached/1e6) * inPrice * (cacheFactor ?? 0.5) : 0;
  const pout = outPrice ? (tokens.out/1e6) * outPrice : 0;
  return pin + pcached + pout;
}

function calcMonthlyRequests(rateValue){
  if(!rateValue || rateValue <= 0) return 0;
  return rateValue * 30; // RPD * 30 days
}

function renderRows(rows){
  const tbody = document.getElementById('tableBody');
  if(!tbody) return;
  tbody.innerHTML = '';
  const frag = document.createDocumentFragment();
  const state = window.__state;
  if(!state) return;
  const tokens = state.globalTokens || { in: 0, cached: 0, out: 0 };
  const useBatch = state.useBatch || false;
  const monthlyRequests = calcMonthlyRequests(state.rateValue || 0);

  // Calculate costs for all rows to determine ranking
  const rowsWithCosts = rows.map(r => ({
    ...r,
    calculatedCost: calcCostWithCached(tokens, r, useBatch, state.cacheFactor)
  }));

  // Sort by cost to determine top N
  const sortedByCost = [...rowsWithCosts].sort((a,b) => {
    const aCost = a.calculatedCost ?? Number.POSITIVE_INFINITY;
    const bCost = b.calculatedCost ?? Number.POSITIVE_INFINITY;
    return aCost - bCost;
  });

  for(let i = 0; i < rowsWithCosts.length; i++){
    const r = rowsWithCosts[i];
    const tr = document.createElement('tr');
    const key = `${r.provider}::${r.model_id || r.model_name}`;
    tr.dataset.key = key;
    const cost = r.calculatedCost;
    const monthly = cost != null ? cost * monthlyRequests : null;
    const fmt = v => v==null ? '—' : `$${v.toFixed(v>=10?2:3)}`;
    const inputPrice = useBatch ? (r.batch_input != null ? r.batch_input : r.input) : r.input;
    const outputPrice = useBatch ? (r.batch_output != null ? r.batch_output : r.output) : r.output;

    // Add ranking class for top 3
    const rank = sortedByCost.findIndex(item => item === r);
    let rankClass = '';
    let rankBadge = '';
    if(state.showRanking !== false && cost != null){
      if(rank === 0){
        rankClass = 'rank-1';
        rankBadge = '<span class="rank-badge gold">🥇</span>';
      } else if(rank === 1){
        rankClass = 'rank-2';
        rankBadge = '<span class="rank-badge silver">🥈</span>';
      } else if(rank === 2){
        rankClass = 'rank-3';
        rankBadge = '<span class="rank-badge bronze">🥉</span>';
      }
    }

    tr.className = rankClass;
    tr.innerHTML = `
      <td>${r.provider}</td>
      <td>${rankBadge}${r.model_name}</td>
      <td class="price pricing-input-col">${fmtPrice(inputPrice)}</td>
      <td class="price pricing-output-col">${fmtPrice(outputPrice)}</td>
      <td>${fmtContext(r.context_length)}</td>
      <td><span class="avail ${r.availability==='production'?'prod':''}">${r.availability}</span></td>
      <td class="cost">${fmt(cost)}</td>
      <td class="cost monthly-cost">${fmt(monthly)}</td>
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
  // Filter out audio/embedding-only models
  let rows = state.data.filter(m => !m.is_filtered);

  // Apply text filter
  if(state.filterText){
    const searchTerm = state.filterText.toLowerCase();
    rows = rows.filter(m => {
      return (
        m.provider.toLowerCase().includes(searchTerm) ||
        m.model_name.toLowerCase().includes(searchTerm) ||
        m.model_id.toLowerCase().includes(searchTerm) ||
        (m.context_length && m.context_length.toString().includes(searchTerm))
      );
    });
  }
  const key = state.sort.key;
  if(key){
    const dir = state.sort.dir;
    const useBatch = state.useBatch || false;
    const getCost = (m) => {
      const tokens = state.globalTokens || {in:0, cached:0, out:0};
      return calcCostWithCached(tokens, m, useBatch, state.cacheFactor) ?? Number.POSITIVE_INFINITY;
    };
    const getMonthlyCost = (m) => {
      const cost = getCost(m);
      const monthlyRequests = calcMonthlyRequests(state.rateValue || 0);
      return cost !== Number.POSITIVE_INFINITY ? cost * monthlyRequests : Number.POSITIVE_INFINITY;
    };
    const cmp = (a,b) => {
      if(key === 'cost'){
        return getCost(a) - getCost(b);
      }
      if(key === 'monthly'){
        return getMonthlyCost(a) - getMonthlyCost(b);
      }
      if(key === 'input'){
        const aVal = useBatch ? (a.batch_input != null ? a.batch_input : a.input) : a.input;
        const bVal = useBatch ? (b.batch_input != null ? b.batch_input : b.input) : b.input;
        if(aVal == null && bVal == null) return 0;
        if(aVal == null) return 1;
        if(bVal == null) return -1;
        return aVal - bVal;
      }
      if(key === 'output'){
        const aVal = useBatch ? (a.batch_output != null ? a.batch_output : a.output) : a.output;
        const bVal = useBatch ? (b.batch_output != null ? b.batch_output : b.output) : b.output;
        if(aVal == null && bVal == null) return 0;
        if(aVal == null) return 1;
        if(bVal == null) return -1;
        return aVal - bVal;
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

  // Apply top N filter
  if(state.topN && state.topN !== 'all'){
    const n = parseInt(state.topN);
    // Sort by cost first
    const tokens = state.globalTokens || {in:0, cached:0, out:0};
    const useBatch = state.useBatch || false;
    const getCost = (m) => calcCostWithCached(tokens, m, useBatch, state.cacheFactor) ?? Number.POSITIVE_INFINITY;
    rows = rows.slice().sort((a,b) => getCost(a) - getCost(b)).slice(0, n);
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

const PRESETS = {
  chat: { name: '💬 Small Chat', in: 1000, cached: 0, out: 500, rpd: 1000, batch: false },
  context: { name: '📚 Long Context', in: 100000, cached: 0, out: 2000, rpd: 100, batch: false },
  agent: { name: '🤖 Daily Agent', in: 10000, cached: 5000, out: 3000, rpd: 500, batch: false },
  batch: { name: '📦 Batch Processing', in: 50000, cached: 0, out: 5000, rpd: 10000, batch: true },
};

function loadPreset(presetName, state){
  const preset = PRESETS[presetName];
  if(!preset) {
    // Try custom preset from localStorage
    const customPresets = getCustomPresets();
    const custom = customPresets[presetName];
    if(!custom) return;
    applyPreset(custom, state);
    return;
  }
  applyPreset(preset, state);
}

function applyPreset(preset, state){
  const inputTokensEl = document.getElementById('inputTokens');
  const cachedTokensEl = document.getElementById('cachedTokens');
  const outputTokensEl = document.getElementById('outputTokens');
  const rateValueEl = document.getElementById('rateValue');
  const pricingTypeBatchEl = document.getElementById('pricingTypeBatch');
  const pricingTypeStdEl = document.getElementById('pricingTypeStd');

  if(inputTokensEl) inputTokensEl.value = preset.in;
  if(cachedTokensEl) cachedTokensEl.value = preset.cached;
  if(outputTokensEl) outputTokensEl.value = preset.out;
  if(rateValueEl) rateValueEl.value = preset.rpd;

  if(preset.batch && pricingTypeBatchEl) {
    pricingTypeBatchEl.checked = true;
  } else if(pricingTypeStdEl) {
    pricingTypeStdEl.checked = true;
  }

  // Trigger updates
  inputTokensEl?.dispatchEvent(new Event('input'));
  pricingTypeBatchEl?.dispatchEvent(new Event('change'));
  pricingTypeStdEl?.dispatchEvent(new Event('change'));

  showToast(`Loaded preset: ${preset.name}`);
}

function saveCustomPreset(state){
  const name = prompt('Enter a name for this preset:');
  if(!name) return;

  const preset = {
    name: name,
    in: state.globalTokens.in,
    cached: state.globalTokens.cached,
    out: state.globalTokens.out,
    rpd: state.rateValue,
    batch: state.useBatch,
  };

  const customPresets = getCustomPresets();
  customPresets['custom1'] = preset;
  localStorage.setItem('llm-prices-custom-presets', JSON.stringify(customPresets));

  // Show the custom preset button
  const btn = document.getElementById('custom-preset-1');
  if(btn){
    btn.textContent = preset.name;
    btn.style.display = 'inline-block';
  }

  showToast(`Saved custom preset: ${name}`);
}

function getCustomPresets(){
  try {
    const saved = localStorage.getItem('llm-prices-custom-presets');
    return saved ? JSON.parse(saved) : {};
  } catch(e){
    return {};
  }
}

function loadCustomPresets(){
  const presets = getCustomPresets();
  if(presets.custom1){
    const btn = document.getElementById('custom-preset-1');
    if(btn){
      btn.textContent = presets.custom1.name;
      btn.style.display = 'inline-block';
    }
  }
}

function setupKeyboardShortcuts(state){
  document.addEventListener('keydown', (e) => {
    // Ignore if user is typing in an input field
    if(e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    const key = e.key.toLowerCase();

    // 1-5 - Load presets
    if(key >= '1' && key <= '5'){
      e.preventDefault();
      const presetKeys = ['chat', 'context', 'agent', 'batch', 'custom1'];
      const presetName = presetKeys[parseInt(key) - 1];
      loadPreset(presetName, state);
      return;
    }

    // s - Toggle Standard/Batch
    if(key === 's'){
      e.preventDefault();
      const batchEl = document.getElementById('pricingTypeBatch');
      const stdEl = document.getElementById('pricingTypeStd');
      if(batchEl && stdEl){
        if(state.useBatch){
          stdEl.checked = true;
        } else {
          batchEl.checked = true;
        }
        stdEl.dispatchEvent(new Event('change'));
        batchEl.dispatchEvent(new Event('change'));
      }
    }

    // r - Reset inputs
    if(key === 'r'){
      e.preventDefault();
      const inputTokensEl = document.getElementById('inputTokens');
      const cachedTokensEl = document.getElementById('cachedTokens');
      const outputTokensEl = document.getElementById('outputTokens');
      const rateValueEl = document.getElementById('rateValue');
      if(inputTokensEl) inputTokensEl.value = 1000;
      if(cachedTokensEl) cachedTokensEl.value = 0;
      if(outputTokensEl) outputTokensEl.value = 500;
      if(rateValueEl) rateValueEl.value = 100;
      inputTokensEl?.dispatchEvent(new Event('input'));
    }

    // / - Focus filter (if exists)
    if(key === '/'){
      e.preventDefault();
      const filterEl = document.getElementById('filterInput');
      if(filterEl) filterEl.focus();
    }

    // ? - Show help
    if(key === '?' && e.shiftKey){
      e.preventDefault();
      showKeyboardHelp();
    }

    // c - Copy as CSV
    if(key === 'c'){
      e.preventDefault();
      exportTableAsCSV();
    }

    // m - Copy as Markdown
    if(key === 'm'){
      e.preventDefault();
      exportTableAsMarkdown();
    }
  });
}

function exportTableAsCSV(){
  const state = window.__state;
  if(!state) return;
  const tbody = document.getElementById('tableBody');
  if(!tbody) return;

  const rows = Array.from(tbody.querySelectorAll('tr'));
  const headers = ['Provider', 'Model', 'Input $/M', 'Output $/M', 'Context', 'Availability', 'Cost', 'Monthly'];

  let csv = headers.join(',') + '\n';
  rows.forEach(tr => {
    const cells = Array.from(tr.querySelectorAll('td')).map(td => {
      let text = td.textContent.trim();
      // Escape quotes and wrap in quotes if contains comma
      if(text.includes(',') || text.includes('"')){
        text = '"' + text.replace(/"/g, '""') + '"';
      }
      return text;
    });
    csv += cells.join(',') + '\n';
  });

  copyToClipboard(csv, 'CSV copied to clipboard!');
}

function exportTableAsMarkdown(){
  const state = window.__state;
  if(!state) return;
  const tbody = document.getElementById('tableBody');
  if(!tbody) return;

  const rows = Array.from(tbody.querySelectorAll('tr'));
  const headers = ['Provider', 'Model', 'Input $/M', 'Output $/M', 'Context', 'Availability', 'Cost', 'Monthly'];

  let md = '| ' + headers.join(' | ') + ' |\n';
  md += '|' + headers.map(() => '---').join('|') + '|\n';

  rows.forEach(tr => {
    const cells = Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim());
    md += '| ' + cells.join(' | ') + ' |\n';
  });

  copyToClipboard(md, 'Markdown table copied to clipboard!');
}

function copyToClipboard(text, successMsg){
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(() => {
      showToast(successMsg || 'Copied to clipboard!');
    }).catch(err => {
      console.error('Failed to copy:', err);
      showToast('Failed to copy to clipboard', true);
    });
  } else {
    // Fallback for older browsers
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
      showToast(successMsg || 'Copied to clipboard!');
    } catch(err){
      console.error('Failed to copy:', err);
      showToast('Failed to copy to clipboard', true);
    }
    document.body.removeChild(textarea);
  }
}

function showToast(message, isError = false){
  const existing = document.getElementById('toast-notification');
  if(existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'toast-notification';
  toast.textContent = message;
  toast.style.cssText = `
    position: fixed; bottom: 24px; right: 24px; z-index: 2000;
    background: ${isError ? 'var(--red)' : 'var(--green)'}; color: #000;
    padding: 12px 20px; border-radius: 8px; font-size: 14px; font-weight: 500;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    animation: slideIn 0.3s ease-out;
  `;

  const style = document.createElement('style');
  style.textContent = `
    @keyframes slideIn {
      from { transform: translateX(400px); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
  `;
  document.head.appendChild(style);

  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'slideIn 0.3s ease-out reverse';
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

function showKeyboardHelp(){
  const existing = document.getElementById('keyboard-help-modal');
  if(existing){
    existing.remove();
    return;
  }

  const modal = document.createElement('div');
  modal.id = 'keyboard-help-modal';
  modal.style.cssText = `
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
    background: var(--panel); border: 1px solid var(--border); border-radius: 12px;
    padding: 24px; max-width: 500px; z-index: 1000; box-shadow: 0 8px 32px rgba(0,0,0,0.5);
  `;
  modal.innerHTML = `
    <h2 style="margin: 0 0 16px; font-size: 18px; color: var(--text);">Keyboard Shortcuts</h2>
    <table style="width: 100%; font-size: 14px; color: var(--text);">
      <tr><td style="padding: 4px 0;"><code style="background: var(--bg); padding: 2px 6px; border-radius: 4px;">s</code></td><td style="padding: 4px 0 4px 12px;">Toggle Standard/Batch pricing</td></tr>
      <tr><td style="padding: 4px 0;"><code style="background: var(--bg); padding: 2px 6px; border-radius: 4px;">r</code></td><td style="padding: 4px 0 4px 12px;">Reset inputs to defaults</td></tr>
      <tr><td style="padding: 4px 0;"><code style="background: var(--bg); padding: 2px 6px; border-radius: 4px;">/</code></td><td style="padding: 4px 0 4px 12px;">Focus filter input</td></tr>
      <tr><td style="padding: 4px 0;"><code style="background: var(--bg); padding: 2px 6px; border-radius: 4px;">c</code></td><td style="padding: 4px 0 4px 12px;">Copy table as CSV</td></tr>
      <tr><td style="padding: 4px 0;"><code style="background: var(--bg); padding: 2px 6px; border-radius: 4px;">m</code></td><td style="padding: 4px 0 4px 12px;">Copy table as Markdown</td></tr>
      <tr><td style="padding: 4px 0;"><code style="background: var(--bg); padding: 2px 6px; border-radius: 4px;">1-5</code></td><td style="padding: 4px 0 4px 12px;">Load preset 1-5</td></tr>
      <tr><td style="padding: 4px 0;"><code style="background: var(--bg); padding: 2px 6px; border-radius: 4px;">?</code></td><td style="padding: 4px 0 4px 12px;">Show this help</td></tr>
    </table>
    <div style="margin-top: 16px; text-align: right;">
      <button id="close-help" style="padding: 6px 12px; background: var(--accent); border: none; color: #000; border-radius: 6px; cursor: pointer; font-weight: 500;">Close</button>
    </div>
  `;

  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.7); z-index: 999;
  `;

  document.body.appendChild(overlay);
  document.body.appendChild(modal);

  const closeHelp = () => {
    modal.remove();
    overlay.remove();
  };

  document.getElementById('close-help').addEventListener('click', closeHelp);
  overlay.addEventListener('click', closeHelp);
  document.addEventListener('keydown', function escHandler(e){
    if(e.key === 'Escape' || e.key === '?'){
      closeHelp();
      document.removeEventListener('keydown', escHandler);
    }
  });
}

function setupUI(state){
  const inputTokensEl = document.getElementById('inputTokens');
  const cachedTokensEl = document.getElementById('cachedTokens');
  const outputTokensEl = document.getElementById('outputTokens');
  const rateValueEl = document.getElementById('rateValue');
  const pricingTypeStdEl = document.getElementById('pricingTypeStd');
  const pricingTypeBatchEl = document.getElementById('pricingTypeBatch');
  const table = document.getElementById('priceTable');

  if(!inputTokensEl || !cachedTokensEl || !outputTokensEl || !rateValueEl || !pricingTypeStdEl || !pricingTypeBatchEl) {
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
    updateURL(state);
    saveState(state);
  };

  const updateRate = () => {
    if(!state) return;
    state.rateValue = Number(rateValueEl.value || 0);
    recalcAllRows(state);
    updateURL(state);
    saveState(state);
  };

  const updatePricingType = () => {
    if(!state) return;
    state.useBatch = pricingTypeBatchEl.checked;
    applyFilterSort(state);
    updateURL(state);
    saveState(state);
  };

  inputTokensEl.addEventListener('input', updateGlobalTokens);
  inputTokensEl.addEventListener('change', updateGlobalTokens);
  cachedTokensEl.addEventListener('input', updateGlobalTokens);
  cachedTokensEl.addEventListener('change', updateGlobalTokens);
  outputTokensEl.addEventListener('input', updateGlobalTokens);
  outputTokensEl.addEventListener('change', updateGlobalTokens);
  rateValueEl.addEventListener('input', updateRate);
  rateValueEl.addEventListener('change', updateRate);
  pricingTypeStdEl.addEventListener('change', updatePricingType);
  pricingTypeBatchEl.addEventListener('change', updatePricingType);

  // Setup preset buttons
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const preset = btn.dataset.preset;
      loadPreset(preset, state);
    });
  });

  // Setup save preset button
  const savePresetBtn = document.getElementById('save-preset-btn');
  if(savePresetBtn){
    savePresetBtn.addEventListener('click', () => saveCustomPreset(state));
  }

  // Setup filter input
  const filterInput = document.getElementById('filterInput');
  if(filterInput){
    filterInput.addEventListener('input', (e) => {
      state.filterText = e.target.value;
      applyFilterSort(state);
    });
  }

  // Setup top N filter
  const topNFilter = document.getElementById('topNFilter');
  if(topNFilter){
    topNFilter.addEventListener('change', (e) => {
      state.topN = e.target.value;
      applyFilterSort(state);
    });
  }

  // Setup export buttons
  const exportCsvBtn = document.getElementById('export-csv-btn');
  if(exportCsvBtn){
    exportCsvBtn.addEventListener('click', exportTableAsCSV);
  }

  const exportMdBtn = document.getElementById('export-md-btn');
  if(exportMdBtn){
    exportMdBtn.addEventListener('click', exportTableAsMarkdown);
  }

  // Setup help button
  const showHelpBtn = document.getElementById('show-help-btn');
  if(showHelpBtn){
    showHelpBtn.addEventListener('click', showKeyboardHelp);
  }

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
  const useBatch = state.useBatch || false;
  const monthlyRequests = calcMonthlyRequests(state.rateValue || 0);
  tbody.querySelectorAll('tr').forEach(tr => {
    const key = tr.dataset.key;
    const m = modelByKey.get(key);
    if(!m) return;
    const costCell = tr.querySelector('.cost:not(.monthly-cost)');
    const monthlyCell = tr.querySelector('.monthly-cost');
    const inputPriceCell = tr.querySelector('.pricing-input-col');
    const outputPriceCell = tr.querySelector('.pricing-output-col');
    if(!costCell || !monthlyCell) return;
    const cost = calcCostWithCached(tokens, m, useBatch, state.cacheFactor);
    const monthly = cost != null ? cost * monthlyRequests : null;
    const fmt = v => v==null ? '—' : `$${v.toFixed(v>=10?2:3)}`;
    costCell.textContent = fmt(cost);
    monthlyCell.textContent = fmt(monthly);
    if(inputPriceCell){
      const inputPrice = useBatch ? (m.batch_input != null ? m.batch_input : m.input) : m.input;
      inputPriceCell.textContent = fmtPrice(inputPrice);
    }
    if(outputPriceCell){
      const outputPrice = useBatch ? (m.batch_output != null ? m.batch_output : m.output) : m.output;
      outputPriceCell.textContent = fmtPrice(outputPrice);
    }
  });
}

// Parse URL parameters and return state values
function parseURLParams(){
  const params = new URLSearchParams(window.location.search);
  return {
    inputTokens: params.get('in') || null,
    cachedTokens: params.get('cached') || null,
    outputTokens: params.get('out') || null,
    rateValue: params.get('rpd') || null,
    useBatch: params.get('mode') === 'batch',
  };
}

// Update URL with current state (without page reload)
function updateURL(state){
  if(!state) return;
  const params = new URLSearchParams();
  const tokens = state.globalTokens || {};
  if(tokens.in) params.set('in', tokens.in);
  if(tokens.cached) params.set('cached', tokens.cached);
  if(tokens.out) params.set('out', tokens.out);
  if(state.rateValue) params.set('rpd', state.rateValue);
  if(state.useBatch) params.set('mode', 'batch');
  const newURL = params.toString() ? `${window.location.pathname}?${params.toString()}` : window.location.pathname;
  window.history.replaceState({}, '', newURL);
}

// Save state to localStorage
function saveState(state){
  if(!state) return;
  try {
    const toSave = {
      globalTokens: state.globalTokens,
      rateValue: state.rateValue,
      useBatch: state.useBatch,
    };
    localStorage.setItem('llm-prices-state', JSON.stringify(toSave));
  } catch(e){
    console.warn('Failed to save state:', e);
  }
}

// Load state from localStorage
function loadState(){
  try {
    const saved = localStorage.getItem('llm-prices-state');
    return saved ? JSON.parse(saved) : null;
  } catch(e){
    console.warn('Failed to load state:', e);
    return null;
  }
}

async function main(){
  // Try URL params first, then localStorage, then smart defaults
  const urlParams = parseURLParams();
  const savedState = loadState();

  const state = {
    data: [],
    sort: { key: 'provider', dir: 'asc' },
    globalTokens: {
      in: parseInt(urlParams.inputTokens) || (savedState?.globalTokens?.in) || 1000,
      cached: parseInt(urlParams.cachedTokens) || (savedState?.globalTokens?.cached) || 0,
      out: parseInt(urlParams.outputTokens) || (savedState?.globalTokens?.out) || 500,
    },
    cacheFactor: 0.5,
    rateValue: parseFloat(urlParams.rateValue) || savedState?.rateValue || 100,
    rateType: 'RPM',
    useBatch: urlParams.useBatch || savedState?.useBatch || false,
    filterText: '',
    topN: 'all',
    showRanking: true,
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
      // Note: batch columns are now controlled by the pricing type toggle
    }

    setupUI(state);
    setupSort(state);
    setupKeyboardShortcuts(state);
    loadCustomPresets();

    // Initialize UI with loaded state
    const inputTokensEl = document.getElementById('inputTokens');
    const cachedTokensEl = document.getElementById('cachedTokens');
    const outputTokensEl = document.getElementById('outputTokens');
    const rateValueEl = document.getElementById('rateValue');
    const pricingTypeBatchEl = document.getElementById('pricingTypeBatch');
    const pricingTypeStdEl = document.getElementById('pricingTypeStd');

    if(inputTokensEl) inputTokensEl.value = state.globalTokens.in;
    if(cachedTokensEl) cachedTokensEl.value = state.globalTokens.cached;
    if(outputTokensEl) outputTokensEl.value = state.globalTokens.out;
    if(rateValueEl) rateValueEl.value = state.rateValue;
    if(state.useBatch && pricingTypeBatchEl) pricingTypeBatchEl.checked = true;
    else if(pricingTypeStdEl) pricingTypeStdEl.checked = true;

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
