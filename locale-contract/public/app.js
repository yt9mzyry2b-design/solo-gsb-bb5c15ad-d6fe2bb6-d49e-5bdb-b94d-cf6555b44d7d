'use strict';

/* ---------------- 状态 ---------------- */
const state = {
  projects: [],
  currentId: null,
  project: null,
  findings: [],
  tab: 'messages',
  keyFilter: '',
  findingFilters: { severity: '', locale: '', search: '' },
  localeModalMode: 'paste',
  pendingFiles: [],
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: options.body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
    ...options,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { ok: false, error: text };
  }
  if (!res.ok && data.ok === undefined) data.ok = false;
  return data;
}

function toast(msg, type = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${type}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 3200);
}

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/* ---------------- 项目 ---------------- */
async function loadProjects(selectId = null) {
  state.projects = await api('/api/projects');
  const list = $('#project-list');
  if (state.projects.length === 0) {
    list.innerHTML = `<div style="color:var(--text-faint);font-size:12px;padding:8px">暂无项目</div>`;
  } else {
    list.innerHTML = state.projects
      .map(
        (p) => `
      <div class="project-item ${p.id === state.currentId ? 'active' : ''}" data-id="${p.id}">
        <div class="pi-name">${esc(p.name)}</div>
        <div class="pi-meta">${p.locale_count} 种语言 · ${p.key_count} 个键</div>
      </div>`
      )
      .join('');
  }
  list.querySelectorAll('.project-item').forEach((el) => {
    el.addEventListener('click', () => openProject(Number(el.dataset.id)));
  });
  if (selectId) await openProject(selectId);
}

async function createProject(name = null) {
  const finalName = name || prompt('项目名称：', '我的消息目录');
  if (!finalName) return;
  const r = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: finalName }) });
  await loadProjects(r.id);
  openLocaleModal();
}

async function openProject(id) {
  state.currentId = id;
  state.project = await api(`/api/projects/${id}`);
  await renderWorkspace();
  loadProjects();
}

async function deleteProject() {
  if (!confirm(`确定删除项目「${state.project.name}」？该操作不可恢复。`)) return;
  await api(`/api/projects/${state.currentId}`, { method: 'DELETE' });
  state.currentId = null;
  state.project = null;
  $('#workspace').classList.add('hidden');
  $('#empty-state').classList.remove('hidden');
  loadProjects();
}

/* ---------------- 工作区渲染 ---------------- */
async function renderWorkspace() {
  const p = state.project;
  if (!p) return;
  $('#empty-state').classList.add('hidden');
  $('#workspace').classList.remove('hidden');

  $('#project-name').textContent = p.name;
  $('#meta-locales').textContent = `🌐 ${p.locales.length} 种语言`;
  $('#meta-keys').textContent = `🔑 ${p.keys.length} 个消息键`;
  $('#stat-error').textContent = p.summary.error;
  $('#stat-warning').textContent = p.summary.warning;
  $('#stat-locale-count').textContent = p.locales.length;
  $('#stat-key-count').textContent = p.keys.length;

  const baseSel = $('#base-locale');
  baseSel.innerHTML =
    `<option value="">自动</option>` +
    p.locales.map((l) => `<option value="${esc(l.code)}" ${l.code === p.base_locale ? 'selected' : ''}>${esc(l.code)}</option>`).join('');

  $('#btn-export-json').href = `/api/projects/${p.id}/report.json`;
  $('#btn-export-csv').href = `/api/projects/${p.id}/report.csv`;

  $('#tab-keys-n').textContent = p.keys.length;
  $('#tab-locales-n').textContent = p.locales.length;

  const fLocale = $('#filter-locale');
  const cur = fLocale.value;
  fLocale.innerHTML =
    `<option value="">全部语言</option>` +
    p.locales.map((l) => `<option value="${esc(l.code)}">${esc(l.code)}</option>`).join('');
  fLocale.value = cur;

  renderMessageList();
  renderLocaleCards();
  await renderFindings();
}

function findingsByKey() {
  const map = new Map();
  for (const f of state.findings) {
    if (!map.has(f.key)) map.set(f.key, { error: 0, warning: 0, info: 0, parse: 0 });
    const m = map.get(f.key);
    m[f.severity]++;
    if (f.code === 'PARSE_ERROR') m.parse++;
  }
  return map;
}

function renderMessageList() {
  const p = state.project;
  const fMap = findingsByKey();
  const q = state.keyFilter.trim().toLowerCase();
  const keys = p.keys.filter((k) => !q || k.key.toLowerCase().includes(q));

  const el = $('#message-list');
  if (keys.length === 0) {
    el.innerHTML = `<div class="empty-hint"><span class="big">🔍</span>${q ? '没有匹配的消息键' : '暂无消息，请先添加语言目录'}</div>`;
    return;
  }
  el.innerHTML = keys
    .map((k) => {
      const m = fMap.get(k.key);
      const badges = [];
      if (m?.parse) badges.push(`<span class="badge badge-parse">解析错误 ×${m.parse}</span>`);
      if (m?.error) badges.push(`<span class="badge badge-error">错误 ×${m.error}</span>`);
      if (m?.warning) badges.push(`<span class="badge badge-warning">警告 ×${m.warning}</span>`);
      if (Number(k.non_strings) > 0 && !m) badges.push(`<span class="badge badge-dim">非字符串 ×${k.non_strings}</span>`);
      if (!badges.length) badges.push(`<span class="badge" style="background:var(--ok-bg);color:var(--ok)">✓ 一致</span>`);
      return `
      <div class="msg-row" data-key="${esc(k.key)}">
        <span class="msg-key">${esc(k.key)}</span>
        <span class="msg-badges">${badges.join('')}</span>
      </div>`;
    })
    .join('');
  el.querySelectorAll('.msg-row').forEach((row) =>
    row.addEventListener('click', () => openMessageModal(row.dataset.key))
  );
}

function renderLocaleCards() {
  const p = state.project;
  const el = $('#locale-cards');
  if (p.locales.length === 0) {
    el.innerHTML = `<div class="empty-hint"><span class="big">🌐</span>还没有语言，点击右上角「＋ 添加语言」</div>`;
    return;
  }
  el.innerHTML = p.locales
    .map((l) => `
    <div class="locale-card">
      <div class="lc-head">
        <div>
          <span class="lc-code">${esc(l.code)}</span>
          ${l.code === p.base_locale ? '<span class="lc-base">基准</span>' : ''}
          <div class="lc-meta">${l.key_count} 个键 · 来源 ${esc(l.source)} ${l.parse_error_count ? '· <span style="color:var(--error)">' + l.parse_error_count + ' 条解析错误</span>' : ''}</div>
        </div>
        <div class="lc-actions">
          <button class="btn btn-sm" data-action="reanalyze" data-locale="${esc(l.code)}">重跑分析</button>
          <button class="btn btn-sm btn-danger-ghost" data-action="delete" data-locale="${esc(l.code)}">删除</button>
        </div>
      </div>
    </div>`)
    .join('');

  el.querySelectorAll('button[data-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const code = btn.dataset.locale;
      if (btn.dataset.action === 'delete') {
        if (!confirm(`删除语言 ${code} 及其全部消息？`)) return;
        await api(`/api/projects/${state.currentId}/locales/${encodeURIComponent(code)}`, { method: 'DELETE' });
        await openProject(state.currentId);
        toast(`已删除 ${code}`, 'success');
      } else {
        const r = await api(`/api/projects/${state.currentId}/analyze`, {
          method: 'POST',
          body: JSON.stringify({}),
        });
        await openProject(state.currentId);
        toast(`分析完成：${r.summary.error} 错误 / ${r.summary.warning} 警告`, 'success');
      }
    });
  });
}

/* ---------------- 问题清单 ---------------- */
async function renderFindings() {
  const { severity, locale, search } = state.findingFilters;
  const params = new URLSearchParams();
  if (severity) params.set('severity', severity);
  if (locale) params.set('locale', locale);
  if (search) params.set('search', search);
  state.findings = await api(`/api/projects/${state.currentId}/findings?${params}`);

  const el = $('#findings-list');
  if (state.findings.length === 0) {
    el.innerHTML = `<div class="empty-hint"><span class="big">🎉</span>没有匹配的问题，各语言目录保持一致</div>`;
    return;
  }
  el.innerHTML = state.findings.map(renderFinding).join('');
  el.querySelectorAll('.finding').forEach((f) =>
    f.addEventListener('click', () => openMessageModal(f.dataset.key))
  );
}

function renderFinding(f) {
  const sevText = { error: '错误', warning: '警告', info: '提示' }[f.severity];
  let diff = '';
  if (f.expected || f.actual) {
    diff = `<div class="f-diff">
      ${f.expected ? `<span class="exp">基准：${esc(f.expected)}</span>` : ''}
      ${f.actual ? `<span class="act">实际：${esc(f.actual)}</span>` : ''}
    </div>`;
  }
  let snippet = '';
  if (f.location && typeof f.location === 'object' && f.location.excerpt) {
    const loc = f.location;
    const caretLine = loc.caret
      ? loc.caret
          .split('')
          .map((c) => (c === '^' ? `<span class="caret">^</span>` : c))
          .join('')
      : '';
    snippet = `<div class="f-snippet">${esc(loc.excerpt)}\n${caretLine}<span class="caret"> L${loc.line}:${loc.column}</span></div>`;
  } else if (f.location && typeof f.location === 'object' && f.location.start) {
    snippet = `<div class="f-snippet"><span class="caret">位置 L${f.location.start.line}:${f.location.start.column}</span></div>`;
  }
  return `
  <div class="finding severity-${f.severity}" data-key="${esc(f.key)}">
    <div class="f-top">
      <span class="f-sev ${f.severity}">${sevText}</span>
      <span class="f-locale">${esc(f.locale_code || '-')}</span>
      <span class="f-code">${esc(f.code)}</span>
    </div>
    <div class="f-key">${esc(f.key || '')}</div>
    <div class="f-msg">${esc(f.message)}</div>
    ${diff}
    ${f.detail ? `<div class="f-detail">${esc(f.detail)}</div>` : ''}
    ${snippet}
  </div>`;
}

/* ---------------- 添加语言弹窗 ---------------- */
function openLocaleModal() {
  if (!state.currentId) return;
  $('#modal-locale').classList.remove('hidden');
  $('#locale-code').value = '';
  $('#locale-content').value = '';
  $('#ingest-error').classList.add('hidden');
  state.pendingFiles = [];
  renderFileList();
  setIngestMode('paste');
}

function closeModals() {
  $$('.modal').forEach((m) => m.classList.add('hidden'));
}

function setIngestMode(mode) {
  state.localeModalMode = mode;
  $$('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('#mode-paste').classList.toggle('hidden', mode !== 'paste');
  $('#mode-upload').classList.toggle('hidden', mode !== 'upload');
}

function guessLocale(filename) {
  const base = filename.replace(/\.json$/i, '');
  const m = base.match(/([a-z]{2,3}(?:[-_][A-Za-z0-9]+)*)$/i);
  return (m ? m[1] : base).replace(/_/g, '-');
}

function renderFileList() {
  const el = $('#file-list');
  if (state.pendingFiles.length === 0) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = state.pendingFiles
    .map(
      (f, i) => `
    <div class="file-item">
      <span>📄</span>
      <code>${esc(f.name)}</code>
      <span class="fi-guess">→ ${esc(guessLocale(f.name))}</span>
      <button class="btn btn-sm btn-danger-ghost" data-rm="${i}">✕</button>
    </div>`
    )
    .join('');
  el.querySelectorAll('[data-rm]').forEach((b) =>
    b.addEventListener('click', () => {
      state.pendingFiles.splice(Number(b.dataset.rm), 1);
      renderFileList();
    })
  );
}

async function doIngest() {
  const errEl = $('#ingest-error');
  errEl.classList.add('hidden');
  const pid = state.currentId;

  if (state.localeModalMode === 'paste') {
    const code = $('#locale-code').value.trim();
    const content = $('#locale-content').value;
    if (!code) return showIngestError('请填写语言代码');
    if (!content.trim()) return showIngestError('请粘贴 JSON 内容');
    const r = await api(`/api/projects/${pid}/locales`, {
      method: 'POST',
      body: JSON.stringify({ locale: code, content, source: 'pasted' }),
    });
    if (!r.ok) return showIngestError(r.error + (r.location ? `\n位置 L${r.location.start?.line}:${r.location.start?.column}` : ''));
    closeModals();
    await openProject(pid);
    toast(`已导入 ${code}：${r.ingested} 个键`, 'success');
    return;
  }

  if (state.pendingFiles.length === 0) return showIngestError('请选择至少一个 .json 文件');
  const fd = new FormData();
  for (const f of state.pendingFiles) fd.append('files', f, f.name);
  const res = await fetch(`/api/projects/${pid}/locales/upload`, { method: 'POST', body: fd });
  const r = await res.json();
  const failed = r.results.filter((x) => !x.ok);
  if (failed.length) {
    showIngestError(failed.map((x) => `【${x.file} → ${x.locale}】${x.error}`).join('\n'));
  }
  if (r.analysis) {
    closeModals();
    await openProject(pid);
    const ok = r.results.filter((x) => x.ok);
    toast(`已导入 ${ok.length} 个文件：${r.analysis.summary.error} 错误 / ${r.analysis.summary.warning} 警告`, failed.length ? 'error' : 'success');
  }
}

function showIngestError(msg) {
  const el = $('#ingest-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

/* ---------------- 消息详情 + 预览 ---------------- */
let msgDetail = { key: null, messages: [], previewLocale: null, vars: {} };

async function openMessageModal(key) {
  const pid = state.currentId;
  const rows = await api(`/api/projects/${pid}/messages?key=${encodeURIComponent(key)}`);
  msgDetail = { key, messages: rows, previewLocale: state.project.base_locale || rows[0]?.locale_code || null, vars: {} };
  $('#msg-key').textContent = key;
  renderMessageModal();
  $('#modal-message').classList.remove('hidden');

  // 以基准语言的变量结构初始化表单
  const ref = rows.find((r) => r.locale_code === state.project.base_locale) || rows[0];
  if (ref && ref.parse_ok) {
    await runPreview(true);
  }
}

function renderMessageModal() {
  const body = $('#msg-body');
  const p = state.project;
  const localeOptions = msgDetail.messages
    .map((m) => `<option value="${esc(m.locale_code)}" ${m.locale_code === msgDetail.previewLocale ? 'selected' : ''}>${esc(m.locale_code)}</option>`)
    .join('');

  const blocks = msgDetail.messages
    .map((m) => {
      const invalid = m.value_type !== 'string' || !m.parse_ok;
      let errorBox = '';
      if (m.value_type !== 'string') {
        errorBox = `<div class="mlb-nonstring">非字符串值（${esc(m.value_type)}），未参与 ICU 对比</div>`;
      } else if (!m.parse_ok) {
        errorBox = `<div class="mlb-error">⛔ ${esc(m.parse_error)}</div>`;
      }
      return `
      <div class="msg-locale-block">
        <div class="mlb-head">
          <span class="mlb-locale">${esc(m.locale_code)}</span>
          ${m.locale_code === p.base_locale ? '<span class="lc-base">基准</span>' : ''}
        </div>
        <div class="mlb-body">
          <div class="mlb-text ${invalid ? 'invalid' : ''}">${esc(m.message)}</div>
          ${errorBox}
        </div>
      </div>`;
    })
    .join('');

  body.innerHTML = `
    <div class="msg-grid">${blocks}</div>
    <div class="preview-box">
      <h4>🧪 变量预览渲染</h4>
      <div class="preview-toolbar">
        <select id="preview-locale">${localeOptions}</select>
        <span class="spacer"></span>
        <button class="btn btn-sm" id="btn-fill-sample">填入示例值</button>
      </div>
      <div class="var-grid" id="var-grid"><div style="color:var(--text-faint);font-size:12px">该消息没有占位符，或当前语言无法解析。</div></div>
      <div class="preview-output" id="preview-output">—</div>
    </div>`;

  $('#preview-locale').addEventListener('change', (e) => {
    msgDetail.previewLocale = e.target.value;
    msgDetail.vars = {};
    renderPreviewForm();
  });
  $('#btn-fill-sample').addEventListener('click', fillSampleVars);
  renderPreviewForm();
}

async function renderPreviewForm() {
  const pid = state.currentId;
  const { key, previewLocale } = msgDetail;
  const grid = $('#var-grid');
  const out = $('#preview-output');
  if (!previewLocale) {
    grid.innerHTML = '';
    out.textContent = '—';
    return;
  }
  // 先空渲染一次，后端会返回该消息需要的变量列表
  const r = await api(`/api/projects/${pid}/preview`, {
    method: 'POST',
    body: JSON.stringify({ locale: previewLocale, key, values: msgDetail.vars }),
  });
  if (!r.ok) {
    grid.innerHTML = `<div style="color:var(--error);font-size:12px">无法生成变量表单：${esc(r.error)}</div>`;
    out.className = 'preview-output error';
    out.textContent = r.error;
    return;
  }
  const variables = r.variables || [];
  if (variables.length === 0) {
    grid.innerHTML = `<div style="color:var(--text-faint);font-size:12px">该消息没有可替换的占位符。</div>`;
  } else {
    grid.innerHTML = variables
      .map(
        (v) => `
      <div class="var-field">
        <label><span class="vk">{${esc(v.name)}}</span> ${esc(v.kind)}${v.style ? ' · ' + esc(v.style) : ''}</label>
        <input data-var="${esc(v.name)}" data-kind="${esc(v.kind)}" type="${v.inputType}"
               value="${esc(msgDetail.vars[v.name] ?? '')}" placeholder="${esc(v.kind)}" />
      </div>`
      )
      .join('');
    grid.querySelectorAll('input[data-var]').forEach((input) => {
      input.addEventListener('input', debounce(() => {
        msgDetail.vars[input.dataset.var] = input.value;
        runPreview();
      }, 250));
    });
  }
  out.className = 'preview-output';
  out.textContent = r.output;
}

async function runPreview(initial = false) {
  const pid = state.currentId;
  const { key, previewLocale } = msgDetail;
  if (!previewLocale) return;
  const r = await api(`/api/projects/${pid}/preview`, {
    method: 'POST',
    body: JSON.stringify({ locale: previewLocale, key, values: msgDetail.vars }),
  });
  const out = $('#preview-output');
  if (!r.ok) {
    out.className = 'preview-output error';
    out.textContent = r.error;
    return;
  }
  out.className = 'preview-output';
  out.textContent = r.output;
  if (initial) {
    // 首帧仅用于拿变量列表，不自动填值
  }
}

function fillSampleVars() {
  const inputs = $$('#var-grid input[data-var]');
  inputs.forEach((input) => {
    if (input.value) return;
    const kind = input.dataset.kind;
    let val;
    switch (kind) {
      case 'number':
        val = '1234.5';
        break;
      case 'plural':
      case 'selectordinal':
        val = '3';
        break;
      case 'date':
      case 'time':
        val = '2026-09-23T14:30';
        break;
      case 'select':
        // 无法在前端得知分支名，用常见值
        val = 'other';
        break;
      default:
        val = 'Ada';
    }
    input.value = val;
    msgDetail.vars[input.dataset.var] = val;
  });
  runPreview();
}

function debounce(fn, wait) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

/* ---------------- 示例数据 ---------------- */
const SAMPLE_LOCALES = ['en', 'zh-CN', 'ja'];

async function loadSample() {
  const r = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: '示例：电商通知（en / zh-CN / ja）', baseLocale: 'en' }) });
  const pid = r.id;
  for (const code of SAMPLE_LOCALES) {
    const content = await fetch(`/samples/${code}.json`).then((x) => x.text());
    const ir = await api(`/api/projects/${pid}/locales`, {
      method: 'POST',
      body: JSON.stringify({ locale: code, content, source: `sample:${code}.json` }),
    });
    if (!ir.ok) {
      toast(`${code} 导入失败：${ir.error}`, 'error');
    }
  }
  await loadProjects(pid);
  toast('示例已加载，点击问题可查看详情', 'success');
}

/* ---------------- 事件绑定 ---------------- */
function bindEvents() {
  $('#btn-new-project').addEventListener('click', () => createProject());
  $('#btn-new-project-2').addEventListener('click', () => createProject());
  $('#btn-sample').addEventListener('click', loadSample);
  $('#btn-sample-2').addEventListener('click', loadSample);
  $('#btn-add-locale').addEventListener('click', openLocaleModal);
  $('#btn-delete-project').addEventListener('click', deleteProject);
  $('#btn-ingest').addEventListener('click', doIngest);

  $$('[data-close]').forEach((el) => el.addEventListener('click', closeModals));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModals();
  });

  $$('.seg-btn').forEach((b) => b.addEventListener('click', () => setIngestMode(b.dataset.mode)));

  $('#file-input').addEventListener('change', (e) => {
    state.pendingFiles.push(...e.target.files);
    renderFileList();
    e.target.value = '';
  });
  const dz = $('#dropzone');
  ['dragover', 'dragenter'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', (e) => {
    state.pendingFiles.push(...[...e.dataTransfer.files].filter((f) => /\.json$/i.test(f.name)));
    renderFileList();
  });

  $$('.tab').forEach((t) =>
    t.addEventListener('click', () => {
      state.tab = t.dataset.tab;
      $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
      $('#tab-messages').classList.toggle('hidden', state.tab !== 'messages');
      $('#tab-locales').classList.toggle('hidden', state.tab !== 'locales');
    })
  );

  $('#key-filter').addEventListener('input', (e) => {
    state.keyFilter = e.target.value;
    renderMessageList();
  });

  $('#filter-severity').addEventListener('change', (e) => {
    state.findingFilters.severity = e.target.value;
    renderFindings();
  });
  $('#filter-locale').addEventListener('change', (e) => {
    state.findingFilters.locale = e.target.value;
    renderFindings();
  });
  $('#filter-search').addEventListener(
    'input',
    debounce((e) => {
      state.findingFilters.search = e.target.value;
      renderFindings();
    }, 250)
  );

  $('#base-locale').addEventListener('change', async (e) => {
    const code = e.target.value || null;
    await api(`/api/projects/${state.currentId}`, {
      method: 'PATCH',
      body: JSON.stringify({ baseLocale: code }),
    });
    const r = await api(`/api/projects/${state.currentId}/analyze`, { method: 'POST', body: JSON.stringify({ baseLocale: code }) });
    await openProject(state.currentId);
    toast(`基准语言已切换为 ${r.baseLocale || '自动'}，分析已重跑`, 'success');
  });
}

/* ---------------- 启动 ---------------- */
bindEvents();
loadProjects();
