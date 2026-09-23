'use strict';

/* global document, window, fetch, FileReader */

const state = {
  projects: [],
  projectId: null,
  locales: [],          // [{code,label,raw_json,parse_ok,...}]
  result: null,         // latest analysis result
  reportId: null,
  selectedKey: null,
  selectedFinding: null,
  filter: { text: '', severity: 'all', locale: 'all' },
  samples: {},          // keyPath -> {varName: "string value"}
  editorLocale: null,   // code when editing, null when adding
  previewLocale: {},    // keyPath -> chosen locale
  previewValues: {},    // keyPath -> {varName: input}
};

const $ = (sel) => document.querySelector(sel);

// ---------------- API ----------------

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) { data = {}; }
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${kind}`;
  setTimeout(() => el.classList.add('hidden'), 2600);
  el.classList.remove('hidden');
}

// ---------------- bootstrap ----------------

async function init() {
  bindEvents();
  await loadProjects();
}

function bindEvents() {
  $('#newProjectBtn').addEventListener('click', openProjectModal);
  $('#emptyNewBtn').addEventListener('click', openProjectModal);
  $('#projectCreateBtn').addEventListener('click', createProject);
  $('#projectCancelBtn').addEventListener('click', () => $('#projectModal').classList.add('hidden'));
  $('#projectNameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') createProject(); });

  $('#projectSelect').addEventListener('change', (e) => switchProject(Number(e.target.value)));

  $('#addLocaleBtn').addEventListener('click', () => openLocaleModal(null));
  $('#localeSaveBtn').addEventListener('click', saveLocaleFromModal);
  $('#localeCancelBtn').addEventListener('click', () => $('#localeModal').classList.add('hidden'));
  $('#localeFileInput').addEventListener('change', loadFileIntoModal);
  $('#localeContentInput').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') saveLocaleFromModal();
  });

  $('#analyzeBtn').addEventListener('click', runAnalyze);
  $('#refLocaleSelect').addEventListener('change', () => { /* applied on analyze */ });

  $('#exportJsonBtn').addEventListener('click', () => exportReport('json'));
  $('#exportCsvBtn').addEventListener('click', () => exportReport('csv'));
  $('#historySelect').addEventListener('change', (e) => {
    if (e.target.value) loadReport(Number(e.target.value));
  });

  $('#filterInput').addEventListener('input', (e) => { state.filter.text = e.target.value; renderFindingsAndKeys(); });
  $('#severityFilter').addEventListener('change', (e) => { state.filter.severity = e.target.value; renderFindingsAndKeys(); });
  $('#localeFilter').addEventListener('change', (e) => { state.filter.locale = e.target.value; renderFindingsAndKeys(); });
}

// ---------------- projects ----------------

async function loadProjects() {
  const data = await api('/api/projects');
  state.projects = data.projects;
  renderProjectSelect();
  if (state.projects.length) {
    const keep = state.projects.find(p => p.id === state.projectId);
    await switchProject(keep ? keep.id : state.projects[0].id);
  } else {
    state.projectId = null;
    $('#emptyState').classList.remove('hidden');
    $('#app').classList.add('hidden');
  }
}

function renderProjectSelect() {
  const sel = $('#projectSelect');
  sel.innerHTML = '';
  for (const p of state.projects) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    if (p.id === state.projectId) opt.selected = true;
    sel.appendChild(opt);
  }
}

async function switchProject(id) {
  state.projectId = id;
  state.result = null;
  state.reportId = null;
  state.selectedKey = null;
  state.selectedFinding = null;
  $('#emptyState').classList.add('hidden');
  $('#app').classList.remove('hidden');
  renderProjectSelect();
  await Promise.all([loadLocales(), loadSamples()]);
  renderRefSelect();
  renderLocaleList();
  renderHistory([]);
  renderEmptyResult();
  await loadLatestReport();
}

async function loadLatestReport() {
  const data = await api(`/api/projects/${state.projectId}`);
  const latest = data.reports && data.reports[0];
  if (latest) {
    await loadReport(latest.id, { silent: true });
  }
}

function openProjectModal() {
  $('#projectNameInput').value = '';
  $('#projectModal').classList.remove('hidden');
  setTimeout(() => $('#projectNameInput').focus(), 50);
}

async function createProject() {
  const name = $('#projectNameInput').value.trim() || '未命名项目';
  const data = await api('/api/projects', { method: 'POST', body: { name } });
  $('#projectModal').classList.add('hidden');
  await loadProjects();
  await switchProject(data.project.id);
  toast('项目已创建', 'success');
}

// ---------------- locales ----------------

async function loadLocales() {
  const data = await api(`/api/projects/${state.projectId}/locales`);
  state.locales = data.locales;
  $('#localeFilter').innerHTML = '<option value="all">全部语言</option>' +
    state.locales.map(l => `<option value="${esc(l.code)}">${esc(l.code)}</option>`).join('');
}

function renderRefSelect() {
  const sel = $('#refLocaleSelect');
  sel.innerHTML = state.locales
    .map(l => `<option value="${esc(l.code)}">${esc(l.code)}</option>`).join('');
  const project = state.projects.find(p => p.id === state.projectId);
  if (project && project.ref_locale && state.locales.some(l => l.code === project.ref_locale)) {
    sel.value = project.ref_locale;
  }
}

function renderLocaleList() {
  const list = $('#localeList');
  list.innerHTML = '';
  if (!state.locales.length) {
    list.innerHTML = '<p class="muted" style="padding:8px">尚未添加语言。点击「＋ 添加语言」粘贴或上传 JSON。</p>';
    return;
  }
  const statusByLocale = {};
  if (state.result) {
    for (const key of Object.values(state.result.keys)) {
      for (const [code, info] of Object.entries(key.locales)) {
        const st = keyStatusForLocale(key, code, info);
        if (!statusByLocale[code] || rank(st) > rank(statusByLocale[code])) {
          statusByLocale[code] = st;
        }
      }
    }
  }
  for (const loc of state.locales) {
    const st = loc.parse_ok ? (statusByLocale[loc.code] || (state.result ? 'ok' : 'unknown'))
      : (state.result ? 'error' : 'unknown');
    const card = document.createElement('div');
    card.className = 'locale-card';
    card.innerHTML = `
      <div class="lc-top">
        <span class="lc-code"><span class="dot ${st}"></span>${esc(loc.code)}</span>
        <button class="lc-del" title="删除语言">✕</button>
      </div>
      <div class="lc-meta">${esc(loc.parse_error ? `${loc.label ? loc.label + ' · ' : ''}JSON 解析失败` : (loc.label || '点击编辑 JSON'))}</div>
    `;
    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('lc-del')) return;
      openLocaleModal(loc.code);
    });
    card.querySelector('.lc-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`确定删除语言 “${loc.code}” 及其 JSON 内容?`)) return;
      await api(`/api/projects/${state.projectId}/locales/${encodeURIComponent(loc.code)}`, { method: 'DELETE' });
      await loadLocales();
      renderRefSelect();
      renderLocaleList();
      toast('语言已删除');
    });
    list.appendChild(card);
  }
}

function rank(st) {
  return { ok: 0, info: 1, warning: 2, error: 3, unknown: 0 }[st] || 0;
}

function keyStatusForLocale(key, code, info) {
  const sev = key.findings.filter(f => f.locale === code && f.markLocale === code);
  if (!info.exists) return 'error';
  if (sev.some(f => f.severity === 'error')) return 'error';
  if (sev.some(f => f.severity === 'warning')) return 'warning';
  if (sev.some(f => f.severity === 'info')) return 'info';
  return 'ok';
}

function openLocaleModal(code) {
  state.editorLocale = code;
  const loc = code ? state.locales.find(l => l.code === code) : null;
  $('#localeModalTitle').textContent = loc ? `编辑语言 ${loc.code}` : '添加语言';
  $('#localeCodeInput').value = loc ? loc.code : '';
  $('#localeCodeInput').disabled = Boolean(loc);
  $('#localeLabelInput').value = loc ? (loc.label || '') : '';
  $('#localeContentInput').value = loc ? (loc.raw_json || '') : '';
  $('#fileName').textContent = '';
  $('#localeFileInput').value = '';
  $('#localeModal').classList.remove('hidden');
  setTimeout(() => $('#localeCodeInput').focus(), 50);
}

function loadFileIntoModal(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  $('#fileName').textContent = file.name;
  const reader = new FileReader();
  reader.onload = () => {
    $('#localeContentInput').value = String(reader.result || '');
    if (!state.editorLocale && !$('#localeCodeInput').value) {
      const guessed = file.name.replace(/\.json$/i, '');
      $('#localeCodeInput').value = guessed;
    }
  };
  reader.readAsText(file, 'utf-8');
}

async function saveLocaleFromModal() {
  const code = $('#localeCodeInput').value.trim();
  if (!code) return toast('请填写语言代码,例如 en、zh-CN', 'error');
  const label = $('#localeLabelInput').value.trim();
  const content = $('#localeContentInput').value;

  // Client-side JSON sanity check, server enforces too.
  if (content.trim()) {
    try { JSON.parse(content); } catch (err) {
      if (!confirm(`JSON 存在解析问题:\n${err.message}\n仍要保存吗?(保存后可在校验结果中查看)`)) return;
    }
  }

  try {
    if (state.editorLocale) {
      await api(`/api/projects/${state.projectId}/locales/${encodeURIComponent(state.editorLocale)}`, {
        method: 'PUT', body: { label, content },
      });
    } else {
      await api(`/api/projects/${state.projectId}/locales`, {
        method: 'POST', body: { code, label, content },
      });
    }
    $('#localeModal').classList.add('hidden');
    await loadLocales();
    renderRefSelect();
    renderLocaleList();
    toast('语言已保存', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------------- analyze ----------------

async function runAnalyze() {
  if (!state.locales.length) return toast('请先添加至少一种语言', 'error');
  const btn = $('#analyzeBtn');
  btn.disabled = true;
  $('#analyzeHint').textContent = '校验中…';
  try {
    const data = await api(`/api/projects/${state.projectId}/analyze`, {
      method: 'POST',
      body: { refLocale: $('#refLocaleSelect').value || null },
    });
    state.result = data.result;
    state.reportId = data.reportId;
    state.selectedKey = null;
    state.selectedFinding = null;
    applyResult();
    await loadHistorySilent();
    renderLocaleList();
    const s = data.result.summary;
    toast(`校验完成:${s.errors} 错误 / ${s.warnings} 警告`, s.errors ? 'error' : 'success');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    $('#analyzeHint').textContent = '';
  }
}

function applyResult() {
  state.result.findings.forEach((f, i) => { f._gid = i; });
  renderSummary();
  renderFindingsAndKeys();
  renderDetail();
  $('#exportJsonBtn').disabled = false;
  $('#exportCsvBtn').disabled = false;
}

function renderEmptyResult() {
  $('#summaryBadges').innerHTML = '';
  $('#findingList').innerHTML = '<p class="muted" style="padding:10px">尚未运行校验。</p>';
  $('#keyList').innerHTML = '<p class="muted" style="padding:10px">添加语言后点击「运行一致性校验」。</p>';
  $('#findingCount').textContent = '';
  $('#keyCount').textContent = '';
  $('#detailBody').innerHTML = '<p class="empty-hint">选择左侧消息键或问题以查看详情、占位符结构与渲染预览。</p>';
  $('#exportJsonBtn').disabled = true;
  $('#exportCsvBtn').disabled = true;
}

function renderSummary() {
  const s = state.result.summary;
  const badges = $('#summaryBadges');
  badges.innerHTML = `
    <span class="badge error">错误 ${s.errors}</span>
    <span class="badge warning">警告 ${s.warnings}</span>
    <span class="badge info">提示 ${s.infos}</span>
    <span class="badge ok">键 ${s.keys} · 语言 ${s.locales}</span>
  `;
}

// ---------------- findings / keys ----------------

function filteredFindings() {
  const { text, severity, locale } = state.filter;
  let list = state.result ? [...state.result.findings] : [];
  if (severity === 'ok') return [];
  if (severity !== 'all') list = list.filter(f => f.severity === severity);
  if (locale !== 'all') list = list.filter(f => f.locale === locale);
  if (text) {
    const q = text.toLowerCase();
    list = list.filter(f =>
      (f.keyPath || '').toLowerCase().includes(q) ||
      f.message.toLowerCase().includes(q) ||
      f.code.toLowerCase().includes(q));
  }
  const order = { error: 0, warning: 1, info: 2 };
  list.sort((a, b) => {
    if (order[a.severity] !== order[b.severity]) return order[a.severity] - order[b.severity];
    return (a.keyPath || '').localeCompare(b.keyPath || '');
  });
  return list;
}

function renderFindingsAndKeys() {
  if (!state.result) return;
  const findings = filteredFindings();
  const fl = $('#findingList');
  $('#findingCount').textContent = `(${findings.length})`;
  fl.innerHTML = '';
  if (!findings.length) {
    fl.innerHTML = '<p class="muted" style="padding:8px">没有符合筛选条件的问题 🎉</p>';
  }
  for (const f of findings) {
    const el = document.createElement('div');
    el.className = `finding-item ${f.severity}`;
    if (state.selectedFinding === f._gid) el.classList.add('active');
    el.innerHTML = `
      <div class="fi-top">
        <span class="fi-code">${esc(f.code)}</span>
        <span class="fi-code">${esc(f.locale || '-')}</span>
      </div>
      <div class="fi-msg">${esc(f.message)}</div>
      <div class="fi-meta">${esc(f.keyPath || '(语言级)')}</div>
    `;
    el.addEventListener('click', () => {
      state.selectedFinding = f._gid;
      if (f.keyPath) {
        state.selectedKey = f.keyPath;
        state.previewLocale[f.keyPath] = f.markLocale || f.locale;
      }
      renderFindingsAndKeys();
      renderDetail();
    });
    fl.appendChild(el);
  }
  renderKeyList(findings);
}

function renderKeyList(visibleFindings) {
  const kl = $('#keyList');
  kl.innerHTML = '';
  const text = state.filter.text.toLowerCase();
  let keys = state.result.allKeys.slice();
  if (state.filter.severity === 'ok') {
    keys = keys.filter(k => state.result.keys[k].status === 'ok');
  }
  if (text) keys = keys.filter(k => k.toLowerCase().includes(text));
  if (state.filter.locale !== 'all') {
    const loc = state.filter.locale;
    keys = keys.filter(k => {
      const info = state.result.keys[k].locales[loc];
      if (!info || !info.exists) return true;
      return state.result.keys[k].findings.some(f => f.locale === loc);
    });
  }
  $('#keyCount').textContent = `(${keys.length})`;

  const findingKeys = new Set(visibleFindings.map(f => f.keyPath));
  if (!keys.length) {
    kl.innerHTML = '<p class="muted" style="padding:8px">无匹配的键。</p>';
    return;
  }
  for (const keyPath of keys) {
    const key = state.result.keys[keyPath];
    const el = document.createElement('div');
    el.className = 'key-item';
    if (state.selectedKey === keyPath) el.classList.add('active');
    const langChips = state.result.locales.map(l => {
      const info = key.locales[l.code];
      const st = info ? keyStatusForLocale(key, l.code, info) : 'missing';
      return `<span class="ki-lang ${st}" title="${esc(l.code)}:${st}">${esc(l.code)}</span>`;
    }).join('');
    const highlight = findingKeys.has(keyPath) ? '◆ ' : '';
    el.innerHTML = `<span class="ki-path" title="${esc(keyPath)}">${highlight}${esc(keyPath)}</span><span class="ki-langs">${langChips}</span>`;
    el.addEventListener('click', () => {
      state.selectedKey = keyPath;
      state.selectedFinding = null;
      renderFindingsAndKeys();
      renderDetail();
    });
    kl.appendChild(el);
  }
}

// ---------------- detail ----------------

function renderDetail() {
  const body = $('#detailBody');
  if (!state.result) {
    body.innerHTML = '<p class="empty-hint">选择左侧消息键或问题以查看详情、占位符结构与渲染预览。</p>';
    return;
  }
  if (!state.selectedKey) {
    body.innerHTML = '<p class="empty-hint">请选择一条消息键或问题。</p>';
    return;
  }
  const key = state.result.keys[state.selectedKey];
  if (!key) return;
  $('#detailTitle').textContent = truncate(state.selectedKey, 60);

  const focusedFinding = state.selectedFinding != null
    && key.findings.some(f => f._gid === state.selectedFinding)
    ? key.findings.find(f => f._gid === state.selectedFinding)
    : null;

  let html = `<div class="dl-section">
    <h4>消息内容(按语言)</h4>
    <div class="legend">
      <span class="lg-error">错误位置</span><span class="lg-warning">警告位置</span><span class="lg-info">提示位置</span>
    </div>`;

  for (const loc of state.result.locales) {
    const info = key.locales[loc.code];
    const marks = collectMarks(key, loc.code, focusedFinding);
    html += renderLocaleMessage(loc.code, info, marks, focusedFinding);
  }
  html += '</div>';

  html += `<div class="dl-section"><h4>占位符与分支签名</h4>${renderSignatures(key)}</div>`;
  html += `<div class="dl-section"><h4>示例变量 · 实时预览</h4>${renderPreviewEditor(key)}</div>`;

  body.innerHTML = html;
  bindPreviewEvents(key);
}

function collectMarks(key, localeCode, focusedFinding) {
  const marks = [];
  for (const f of key.findings) {
    if (f.markLocale !== localeCode) continue;
    for (const m of (f.marks || [])) {
      marks.push({ ...m, severity: f.severity, code: f.code, focus: focusedFinding === f });
    }
  }
  return marks;
}

function renderLocaleMessage(code, info, marks, focusedFinding) {
  if (!info) {
    return `<div class="message-block">
      <div class="mb-locale"><span>${esc(code)}</span><span class="mb-status" style="color:var(--error)">缺失该键</span></div>
      <div class="mb-text muted">(此语言目录中不存在该键)</div>
    </div>`;
  }
  if (info.valueType !== 'string') {
    return `<div class="message-block">
      <div class="mb-locale"><span>${esc(code)}</span><span class="mb-status" style="color:var(--error)">非字符串:${esc(info.valueType)}</span></div>
      <div class="mb-text">${esc(info.value)}</div>
    </div>`;
  }

  const statusText = !info.parseOk ? '解析失败' : info.empty ? '空消息' : '解析正常';
  const statusColor = !info.parseOk ? 'var(--error)' : 'var(--ok)';
  let textHtml;
  if (info.parseOk) {
    textHtml = renderHighlighted(info.value, marks, focusedFinding);
  } else {
    textHtml = renderHighlighted(info.value, marks, focusedFinding);
  }

  const errBox = info.parseError ? `
    <div class="parse-err-box">
      无法解析:<strong>${esc(info.parseError.hint || '')}</strong>
      <code>[${esc(info.parseError.code || '')}]</code>
      @ line ${info.parseError.start.line}, col ${info.parseError.start.column}
    </div>` : '';

  return `<div class="message-block">
    <div class="mb-locale">
      <span>${esc(code)}</span>
      <span class="mb-status" style="color:${statusColor}">${statusText}</span>
    </div>
    <div class="mb-text">${textHtml || '<span class="muted">(空字符串)</span>'}</div>
    ${errBox}
  </div>`;
}

/** Merge overlapping marks (keep highest severity) then escape slices. */
function renderHighlighted(source, marks, focusedFinding) {
  if (!source) return '';
  const validMarks = marks
    .filter(m => m && m.start >= 0 && m.end > m.start && m.start < source.length)
    .map(m => ({
      start: Math.max(0, m.start),
      end: Math.min(source.length, m.end),
      severity: m.severity,
      code: m.code,
      focus: Boolean(m.focus),
    }))
    .sort((a, b) => a.start - b.start || b.end - a.end);

  // Resolve overlaps: earlier (higher-sorted) mark wins the contested span.
  const resolved = [];
  for (const m of validMarks) {
    let start = m.start;
    while (resolved.length && start < resolved[resolved.length - 1].end) {
      const last = resolved[resolved.length - 1];
      if (m.end <= last.end) { start = m.end; break; }
      // split: tail of m remains
      start = last.end;
    }
    if (start < m.end) resolved.push({ ...m, start, end: m.end });
  }

  let out = '';
  let cursor = 0;
  for (const m of resolved) {
    if (m.start > cursor) out += esc(source.slice(cursor, m.start));
    const cls = `sev-${m.severity}${m.focus ? ' sev-focus' : ''}`;
    out += `<mark class="${cls}" title="${esc(m.code)}">${esc(source.slice(m.start, m.end))}</mark>`;
    cursor = m.end;
  }
  if (cursor < source.length) out += esc(source.slice(cursor));
  return out;
}

function renderSignatures(key) {
  const rows = [];
  for (const loc of state.result.locales) {
    const info = key.locales[loc.code];
    if (!info || !info.signature) {
      rows.push(`<div class="message-block"><div class="mb-locale"><span>${esc(loc.code)}</span></div>
        <span class="muted">${info && info.exists ? '无可用签名(解析失败)' : '—'}</span></div>`);
      continue;
    }
    const vars = Object.values(info.signature.vars);
    const chips = vars.map(v => {
      const kinds = (v.kinds || []).map(k => {
        let label = k.kind;
        if (k.style) label += ':' + k.style;
        if (k.kind === 'selectordinal') label = 'selectordinal';
        if (k.offset) label += ` offset:${k.offset}`;
        return label;
      });
      const uniq = [...new Set(kinds)];
      return `<span class="chip">${esc(v.name)} <span class="ch-type">${esc(uniq.join(' + '))}</span></span>`;
    }).join('');

    rows.push(`<div class="message-block">
      <div class="mb-locale"><span>${esc(loc.code)}</span>
        <span class="mb-status muted">${vars.length} 个占位符</span></div>
      <div class="chip-row">${chips || '<span class="muted">无占位符</span>'}</div>
      <div class="sig-tree" style="margin-top:8px">${renderSigTree(info.signature)}</div>
    </div>`);
  }
  return rows.join('');
}

/** Build a compact tree view from the stored path multiset + branches. */
function renderSigTree(sig) {
  // Reconstruct children map from paths.
  const root = { children: new Map(), varsHere: new Set() };
  for (const v of Object.values(sig.vars)) {
    if (!v.paths || !v.paths.length) {
      root.varsHere.add(v.name);
      continue;
    }
    for (const p of v.paths) {
      const tokens = p ? p.split('/') : [];
      let node = root;
      for (const t of tokens) {
        if (!node.children.has(t)) node.children.set(t, { children: new Map(), varsHere: new Set() });
        node = node.children.get(t);
      }
      node.varsHere.add(v.name);
    }
  }
  return treeHtml(root, true);
}

function treeHtml(node, isRoot) {
  let out = '';
  for (const name of node.varsHere) {
    out += `<span class="node var">⟂ ${esc(name)}</span>`;
  }
  for (const [token, child] of node.children) {
    const m = token.match(/^(plural|selectordinal|select|tag)\((.+?)\)$/);
    const label = m
      ? `<span class="var">${m[1]}(${esc(m[2])})</span>`
      : `<span class="sel">${esc(token)}</span>`;
    out += `<span class="node">${isRoot ? '' : '└ '}${label}</span>`;
    out += `<span class="indent">${treeHtml(child, false)}</span>`;
  }
  return out;
}

// ---------------- preview ----------------

function collectKeyVariables(key) {
  // Union variable name -> set of formats. Use stored signatures, and parse
  // raw messages of any locale without one (parse failures etc.) so variables
  // of the reference message are offered even when a locale dropped them.
  const map = new Map();
  for (const info of Object.values(key.locales)) {
    if (!info.exists || info.valueType !== 'string' || !info.value) continue;
    if (info.signature) {
      for (const v of Object.values(info.signature.vars)) {
        if (!map.has(v.name)) map.set(v.name, new Set());
        map.get(v.name).add(v.format);
      }
      continue;
    }
    const sig = null;
    const names = quickExtractVarNames(info.value);
    for (const name of names) {
      if (!map.has(name)) map.set(name, new Set());
    }
  }
  return [...map.entries()].map(([name, formats]) => ({ name, formats: [...formats] }));
}

function renderPreviewEditor(key) {
  const variables = collectKeyVariables(key);
  const saved = state.samples[state.selectedKey] || {};
  if (!state.previewValues[state.selectedKey]) state.previewValues[state.selectedKey] = { ...saved };
  if (!state.previewLocale[state.selectedKey]) {
    state.previewLocale[state.selectedKey] = state.result.refLocale || state.result.locales[0].code;
  }
  const vals = state.previewValues[state.selectedKey];

  const rows = variables.map(v => `
    <tr>
      <th title="${esc(v.formats.join(' / '))}">${esc(v.name)} <span class="muted">${esc(v.formats.join('+'))}</span></th>
      <td><input data-var="${esc(v.name)}" class="pv-input" value="${esc(vals[v.name] != null ? vals[v.name] : defaultSample(v))}" /></td>
    </tr>`).join('');

  const locOptions = state.result.locales
    .map(l => `<option value="${esc(l.code)}" ${l.code === state.previewLocale[state.selectedKey] ? 'selected' : ''}>${esc(l.code)}</option>`)
    .join('');

  return `
    <table class="preview-table">${rows || '<tr><td class="muted">该消息没有占位符</td></tr>'}</table>
    <div class="preview-head">
      <label class="muted">预览语言
        <select id="pvLocale">${locOptions}</select>
      </label>
      <button class="btn btn-small" id="pvRenderBtn">渲染预览</button>
    </div>
    <div id="pvOutput" class="preview-out muted">填写变量后点击「渲染预览」(纯数字会自动转为 number)。</div>
    <div class="muted" style="margin-top:6px;font-size:11px">示例随项目自动保存,便于下次审查复用。</div>
  `;
}

function defaultSample(v) {
  const fs = v.formats;
  if (fs.includes('number') || fs.includes('plural') || fs.includes('selectordinal')) return '3';
  if (fs.includes('date')) return Date.now();
  if (fs.includes('time')) return Date.now();
  if (fs.includes('select')) return 'other';
  return '';
}

function bindPreviewEvents(key) {
  const body = $('#detailBody');
  const locSel = body.querySelector('#pvLocale');
  if (locSel) {
    locSel.addEventListener('change', (e) => {
      state.previewLocale[state.selectedKey] = e.target.value;
      requestPreview();
    });
  }
  body.querySelectorAll('.pv-input').forEach(input => {
    input.addEventListener('input', debounce(() => requestPreview(), 350));
  });
  const btn = body.querySelector('#pvRenderBtn');
  if (btn) btn.addEventListener('click', requestPreview);
}

async function requestPreview() {
  const keyPath = state.selectedKey;
  const key = state.result.keys[keyPath];
  const loc = state.previewLocale[keyPath];
  const info = key.locales[loc];
  const out = $('#pvOutput');
  if (!info || !info.exists || info.valueType !== 'string') {
    out.className = 'preview-out err';
    out.textContent = '该语言无可用消息。';
    return;
  }
  const vars = collectKeyVariables(key);
  const values = {};
  document.querySelectorAll('.pv-input').forEach((input) => {
    values[input.dataset.var] = input.value;
  });
  state.previewValues[keyPath] = values;

  try {
    const data = await api('/api/preview', {
      method: 'POST',
      body: { message: info.value, locale: loc, values },
    });
    if (data.ok) {
      out.className = 'preview-out';
      out.textContent = data.output;
    } else {
      out.className = 'preview-out err';
      out.textContent = data.error;
    }
  } catch (err) {
    out.className = 'preview-out err';
    out.textContent = err.message;
  }

  // Persist samples (best-effort, debounced separately server-side).
  await api(`/api/projects/${state.projectId}/samples/${encodeURIComponent(keyPath)}`, {
    method: 'PUT', body: { vars: values },
  }).catch(() => {});
}

// ---------------- reports / export ----------------

async function loadHistorySilent() {
  const data = await api(`/api/projects/${state.projectId}/reports`);
  renderHistory(data.reports);
}

function renderHistory(reports) {
  const sel = $('#historySelect');
  sel.innerHTML = '<option value="">历史报告…</option>' +
    (reports || []).map(r =>
      `<option value="${r.id}" ${r.id === state.reportId ? 'selected' : ''}>#${r.id} · ${esc(r.created_at)} · ${esc(r.ref_locale || '-')}</option>`
    ).join('');
}

async function loadReport(id, opts = {}) {
  const data = await api(`/api/projects/${state.projectId}/reports/${id}`);
  state.result = data.result;
  state.reportId = data.reportId;
  state.selectedKey = null;
  state.selectedFinding = null;
  applyResult();
  renderHistorySilentList();
  renderLocaleList();
  if (!opts.silent) toast(`已载入报告 #${id}`);
}

async function renderHistorySilentList() {
  const data = await api(`/api/projects/${state.projectId}/reports`);
  renderHistory(data.reports);
}

function exportReport(format) {
  if (!state.reportId) return;
  window.location.href = `/api/projects/${state.projectId}/reports/${state.reportId}/export?format=${format}`;
}

// ---------------- samples ----------------

async function loadSamples() {
  const data = await api(`/api/projects/${state.projectId}/samples`);
  state.samples = data.samples || {};
}

// ---------------- utils ----------------

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/**
 * Best-effort extraction of top-level placeholder names from ICU text using
 * a brace/quote-aware scanner. Used only to populate preview inputs when no
 * parsed signature is available; the server remains the source of truth.
 */
function quickExtractVarNames(text) {
  const names = new Set();
  let depth = 0;
  const depthStarts = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'") {
      // Skip a quoted literal ('{' / "''" escaped apostrophe) so braces
      // inside text do not affect depth tracking.
      const nextClose = text.indexOf("'", i + 1);
      if (nextClose === -1) break;
      i = nextClose;
      continue;
    }
    if (ch === '{') {
      depthStarts.push(i + 1);
      depth++;
    } else if (ch === '}') {
      depthStarts.pop();
      depth = Math.max(0, depth - 1);
    } else if (ch === ',' && depth >= 1) {
      // End of the argument name for the most recently opened brace.
      const start = depthStarts[depthStarts.length - 1];
      if (start != null && start !== -1) {
        const name = text.slice(start, i).trim();
        if (name && !/^\d+$/.test(name) && !name.includes(' ')) names.add(name);
        depthStarts[depthStarts.length - 1] = -1;
      }
    }
  }
  // Simple arguments with no comma: capture when their brace closes.
  // Strip quoted literals first so '{...}' inside text is ignored.
  const unquoted = text.replace(/'[^']*'/g, "''");
  const simple = unquoted.match(/\{[^{}]+\}/g) || [];
  for (const tok of simple) {
    const body = tok.slice(1, -1).trim();
    if (body && !body.includes(',') && !/^[#\d\s]+$/.test(body)) names.add(body);
  }
  return names;
}

let debounceTimer = null;
function debounce(fn, ms) {
  return (...args) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => fn(...args), ms);
  };
}

init().catch(err => toast(err.message, 'error'));
