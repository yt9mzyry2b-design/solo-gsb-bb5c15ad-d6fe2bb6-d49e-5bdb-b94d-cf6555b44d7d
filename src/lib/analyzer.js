'use strict';

/**
 * Cross-locale ICU MessageFormat contract analyzer.
 *
 * For each locale:
 *   - the catalog JSON is parsed and flattened
 *   - every string message is parsed as ICU and given a structural signature
 *
 * Messages are then compared against a reference locale:
 *   - KEY_MISSING            key absent in a locale
 *   - VALUE_TYPE_INVALID     value exists but is not a string
 *   - LOCALE_JSON_ERROR      the catalog JSON itself is invalid
 *   - PARSE_ERROR            ICU syntax cannot be parsed (position marked)
 *   - INTRA_TYPE_CONFLICT    one variable used with incompatible value roles
 *   - PLACEHOLDER_MISSING    variable used in reference but absent locally
 *   - PLACEHOLDER_EXTRA      variable present locally but not in reference
 *   - TYPE_CONFLICT          no single value can satisfy both usages
 *   - FORMAT_MISMATCH        same variable, different typed display (warning)
 *   - STYLE_MISMATCH         same typed placeholder uses a different style
 *   - OFFSET_MISMATCH        plural offsets differ
 *   - BRANCH_MISSING         plural/select branch category missing
 *   - BRANCH_EXTRA           extra branch category vs reference (info)
 *   - NESTING_MISMATCH       nested container structure differs
 */

const icu = require('./icu');
const { parseCatalog, flatten } = require('./catalog');

const SEVERITY = {
  KEY_MISSING: 'error',
  VALUE_TYPE_INVALID: 'error',
  LOCALE_JSON_ERROR: 'error',
  PARSE_ERROR: 'error',
  INTRA_TYPE_CONFLICT: 'error',
  PLACEHOLDER_MISSING: 'error',
  TYPE_CONFLICT: 'error',
  NESTING_MISMATCH: 'error',
  BRANCH_MISSING: 'error',
  POUND_WITHOUT_PLURAL: 'error',
  OFFSET_MISMATCH: 'warning',
  STYLE_MISMATCH: 'warning',
  FORMAT_MISMATCH: 'warning',
  PLACEHOLDER_EXTRA: 'warning',
  BRANCH_EXTRA: 'info',
  EMPTY_MESSAGE: 'info',
};

/**
 * @param {Array<{code:string,label?:string,content:string}>} localeInputs
 * @param {{refLocale?:string}} [options]
 * @returns {object} analysis result
 */
function analyze(localeInputs, options = {}) {
  const prepared = localeInputs.map(input => prepareLocale(input));
  const codeSet = new Set(prepared.map(l => l.code));
  let refCode = options.refLocale && codeSet.has(options.refLocale)
    ? options.refLocale
    : (prepared[0] && prepared[0].code);

  if (!refCode || !(prepared.find(l => l.code === refCode) || {}).ok) {
    // Fall back to the first parseable locale as reference.
    const candidate = prepared.find(l => l.ok);
    if (candidate) refCode = candidate.code;
  }

  const keySet = new Set();
  for (const loc of prepared) {
    for (const key of loc.messages.keys()) keySet.add(key);
  }
  const allKeys = [...keySet].sort();

  const keys = {};
  for (const keyPath of allKeys) {
    keys[keyPath] = buildKeyReport(keyPath, prepared, refCode);
  }

  const locales = prepared.map(l => ({
    code: l.code,
    label: l.label || '',
    ok: l.ok,
    jsonError: l.jsonError,
    messageCount: l.messages.size,
  }));

  const findings = [];
  for (const loc of prepared) {
    if (loc.jsonError) {
      findings.push({
        severity: 'error',
        code: 'LOCALE_JSON_ERROR',
        locale: loc.code,
        keyPath: null,
        message: `语言 ${loc.code} 的 JSON 无法解析:${loc.jsonError.message}`,
        marks: [{ start: loc.jsonError.position || 0, end: (loc.jsonError.position || 0) + 1 }],
        markLocale: loc.code,
      });
    }
  }
  for (const [keyPath, report] of Object.entries(keys)) {
    for (const f of report.findings) findings.push({ ...f, keyPath });
  }

  const summary = summarize(findings, allKeys.length, prepared.length);

  return {
    generatedAt: new Date().toISOString(),
    refLocale: refCode || null,
    locales,
    allKeys,
    keys,
    findings,
    summary,
  };
}

function prepareLocale(input) {
  const code = (input.code || '').trim();
  const parsed = parseCatalog(input.content);
  if (!parsed.ok) {
    return {
      code,
      label: input.label || '',
      ok: false,
      jsonError: parsed.error,
      messages: new Map(),
      reports: new Map(),
    };
  }
  if (parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    return {
      code,
      label: input.label || '',
      ok: false,
      jsonError: { message: '顶层 JSON 必须是对象,例如 {"greeting":"Hello"}' },
      messages: new Map(),
      reports: new Map(),
    };
  }
  const messages = new Map();
  for (const [k, v] of flatten(parsed.value)) messages.set(k, v);

  const reports = new Map();
  for (const [keyPath, value] of messages) {
    reports.set(keyPath, inspectMessage(value));
  }
  return { code, label: input.label || '', ok: true, jsonError: null, messages, reports };
}

function inspectMessage(value) {
  if (typeof value !== 'string') {
    return {
      type: 'nonstring',
      value: value === undefined ? null : value,
      parseOk: false,
      parseError: null,
      signature: null,
      signatureJSON: null,
      intraConflicts: [],
    };
  }
  if (value.trim() === '') {
    return {
      type: 'message',
      value,
      parseOk: true,
      parseError: null,
      signature: { vars: new Map(), branches: new Map(), pounds: [], rootMark: { start: 0, end: 1 } },
      signatureJSON: { vars: {}, branches: {}, pounds: [] },
      intraConflicts: [],
      empty: true,
    };
  }
  const parsed = icu.parseMessage(value);
  if (!parsed.ok) {
    return {
      type: 'message',
      value,
      parseOk: false,
      parseError: parsed.error,
      signature: null,
      signatureJSON: null,
      intraConflicts: [],
    };
  }
  const signature = icu.extractSignature(parsed.ast, value);
  return {
    type: 'message',
    value,
    parseOk: true,
    parseError: null,
    signature,
    signatureJSON: icu.signatureToJSON(signature),
    intraConflicts: icu.intraMessageConflicts(signature),
    empty: false,
  };
}

function buildKeyReport(keyPath, locales, refCode) {
  const entries = locales.map(loc => {
    const exists = loc.messages.has(keyPath);
    return {
      code: loc.code,
      label: loc.label,
      exists,
      value: exists ? loc.messages.get(keyPath) : undefined,
      report: exists ? loc.reports.get(keyPath) : null,
    };
  });

  const findings = [];

  for (const entry of entries) {
    if (!entry.exists) {
      findings.push(mk('KEY_MISSING', entry.code,
        `语言 ${entry.code} 缺少键 ${keyPath}`, null));
      continue;
    }
    if (entry.report.type === 'nonstring') {
      findings.push(mk('VALUE_TYPE_INVALID', entry.code,
        `语言 ${entry.code} 中 ${keyPath} 的值不是字符串(类型:${valueTypeName(entry.value)})`, null));
      continue;
    }
    if (entry.report.empty) {
      findings.push(mk('EMPTY_MESSAGE', entry.code,
        `语言 ${entry.code} 中 ${keyPath} 为空字符串`, [{ start: 0, end: 1 }]));
    }
    if (!entry.report.parseOk && entry.report.parseError) {
      const err = entry.report.parseError;
      const len = entry.report.value.length;
      let start = Math.max(0, Math.min(err.start.offset, Math.max(0, len - 1)));
      let end = Math.max((err.end ? err.end.offset : 0) + 1, start + 1);
      end = Math.min(end, len);
      if (end <= start) { start = 0; end = Math.max(1, len); }
      const mark = { start, end };
      findings.push(mk('PARSE_ERROR', entry.code,
        `语言 ${entry.code} 中 ${keyPath} ICU 无法解析:${err.hint} [${err.code}]`,
        [mark]));
    }
    for (const c of entry.report.intraConflicts) {
      findings.push(mk('INTRA_TYPE_CONFLICT', entry.code,
        `语言 ${entry.code} 中占位符 ${c.varName} 类型不兼容:${c.expected} 与 ${c.actual}`,
        c.marks));
    }
    const sig = entry.report.signature;
    if (sig) {
      for (const p of sig.pounds) {
        if (!p.valid) {
          findings.push(mk('POUND_WITHOUT_PLURAL', entry.code,
            `语言 ${entry.code} 中 # 出现在 plural 分支之外,无法确定其引用的数值变量`, [p.mark]));
        }
      }
    }
  }

  // Reference-based structural comparison.
  const refEntry = entries.find(e => e.code === refCode);
  if (refEntry && refEntry.exists && refEntry.report && refEntry.report.parseOk && refEntry.report.signature) {
    const refSig = refEntry.report.signature;
    for (const entry of entries) {
      if (entry.code === refCode) continue;
      if (!entry.exists || !entry.report) continue;
      if (entry.report.type !== 'message' || !entry.report.parseOk || !entry.report.signature) continue;
      compareSignatures(keyPath, entry.code, refCode, refSig, entry.report.signature, findings);
    }
  }

  const perLocale = {};
  for (const e of entries) {
    if (!e.exists) {
      perLocale[e.code] = { exists: false };
      continue;
    }
    perLocale[e.code] = {
      exists: true,
      valueType: e.report.type === 'nonstring' ? valueTypeName(e.value) : 'string',
      value: e.report.type === 'nonstring' ? safeJson(e.value) : e.value,
      parseOk: e.report.parseOk,
      parseError: e.report.parseError,
      signature: e.report.signatureJSON,
      empty: Boolean(e.report.empty),
    };
  }

  const status = rollupStatus(findings);
  return { keyPath, status, refLocale: refCode || null, locales: perLocale, findings };
}

function compareSignatures(keyPath, locCode, refCode, refSig, locSig, findings) {
  const refVars = refSig.vars;
  const locVars = locSig.vars;

  // Missing / extra placeholders.
  for (const [name, rv] of refVars) {
    if (!locVars.has(name)) {
      findings.push(mk('PLACEHOLDER_MISSING', locCode,
        `语言 ${locCode} 缺少占位符 ${name}(参考语言 ${refCode} 中用于 ${describeVarUses(rv)})`,
        [wholeMessageMark(locSig)]));
    }
  }
  for (const [name, lv] of locVars) {
    if (!refVars.has(name)) {
      findings.push(mk('PLACEHOLDER_EXTRA', locCode,
        `语言 ${locCode} 出现了参考语言 ${refCode} 中没有的占位符 ${name}(${describeVarUses(lv)})`,
        lv.occurrences.slice(0, 1)));
    }
  }

  for (const [name, rv] of refVars) {
    const lv = locVars.get(name);
    if (!lv) continue;

    const refRoles = [...rv.roles].sort();
    const locRoles = [...lv.roles].sort();

    if (!sameArray(refRoles, locRoles)) {
      if (roleSetsSatisfiable(refRoles, locRoles)) {
        findings.push(mk('FORMAT_MISMATCH', locCode,
          `占位符 ${name} 的使用格式不一致:参考语言 ${refCode} 为 ${describeVarUses(rv)},语言 ${locCode} 为 ${describeVarUses(lv)}`,
          lv.occurrences.slice(0, 1)));
      } else {
        findings.push(mk('TYPE_CONFLICT', locCode,
          `占位符 ${name} 类型冲突(同一取值无法同时满足):参考语言 ${refCode} 为 ${describeVarUses(rv)},语言 ${locCode} 为 ${describeVarUses(lv)}`,
          lv.occurrences.slice(0, 1)));
        // Branch/style comparisons would be noise when roles are incompatible.
        compareStructureOnly(name, rv, lv, refSig, locSig, refCode, locCode, findings);
        continue;
      }
    }

    // Typed display formats (number vs plain interpolation etc.).
    // Only emit when role sets already match, otherwise the role-based
    // FORMAT_MISMATCH above is the more informative report.
    if (sameArray(refRoles, locRoles)) {
      const refDisplay = displayMultiset(rv);
      const locDisplay = displayMultiset(lv);
      if (!sameArray(refDisplay, locDisplay)) {
        const hasTyped = refDisplay.some(d => d !== 'simple') || locDisplay.some(d => d !== 'simple');
        if (hasTyped) {
          findings.push(mk('FORMAT_MISMATCH', locCode,
            `占位符 ${name} 的展示格式不一致:${formatDisplay(rv)} -> ${formatDisplay(lv)}`,
            lv.occurrences.slice(0, 1)));
        }
      }
    }

    // Style comparison for matching typed displays (number/date/time).
    for (const rd of rv.displayKinds) {
      const sameKind = lv.displayKinds.find(ld => ld.kind === rd.kind);
      if (sameKind && rd.style !== sameKind.style) {
        findings.push(mk('STYLE_MISMATCH', locCode,
          `占位符 ${name} 的 ${rd.kind} 格式样式不一致:${rd.style || '默认'} -> ${sameKind.style || '默认'}`,
          lv.occurrences.slice(0, 1)));
      }
    }

    // plural offset
    const refOffset = pluralOffset(rv);
    const locOffset = pluralOffset(lv);
    if (refOffset != null && locOffset != null && refOffset !== locOffset) {
      findings.push(mk('OFFSET_MISMATCH', locCode,
        `plural ${name} 的 offset 不一致:${refOffset} -> ${locOffset}`,
        lv.occurrences.slice(0, 1)));
    }

    // cardinal vs ordinal control mismatch (unique control kinds)
    const refControls = [...new Set(rv.controlKinds.map(c => c.kind))].sort();
    const locControls = [...new Set(lv.controlKinds.map(c => c.kind))].sort();
    if (!sameArray(refControls, locControls) && refControls.length && locControls.length) {
      findings.push(mk('TYPE_CONFLICT', locCode,
        `占位符 ${name} 的分支控制类型不一致:${refControls.join('+')} -> ${locControls.join('+')}`,
        lv.occurrences.slice(0, 1)));
    }

    compareBranches(name, rv, lv, refSig, locSig, refCode, locCode, findings);

    // Nested structure: multiset of container paths where the variable appears.
    if (!sameMultiset(rv.paths, lv.paths)) {
      findings.push(mk('NESTING_MISMATCH', locCode,
        `占位符 ${name} 的嵌套结构与参考语言不一致`,
        lv.occurrences.slice(0, 1)));
    }
  }
}

/** Branches + nesting are structural and useful even given a type conflict. */
function compareStructureOnly(name, rv, lv, refSig, locSig, refCode, locCode, findings) {
  compareBranches(name, rv, lv, refSig, locSig, refCode, locCode, findings);
  if (!sameMultiset(rv.paths, lv.paths)) {
    findings.push(mk('NESTING_MISMATCH', locCode,
      `占位符 ${name} 的嵌套结构与参考语言不一致`,
      lv.occurrences.slice(0, 1)));
  }
}

function compareBranches(name, rv, lv, refSig, locSig, refCode, locCode, findings) {
  const refBranchMap = branchSelectorMap(refSig, name);
  const locBranchMap = branchSelectorMap(locSig, name);
  for (const kind of Object.keys(refBranchMap)) {
    const refSet = refBranchMap[kind];
    const locSet = locBranchMap[kind];
    // When the variable is not the same control kind locally (already
    // reported as TYPE_CONFLICT / FORMAT_MISMATCH), per-category comparison
    // is meaningless (e.g. simple interpolation has no branches at all).
    if (!locSet) continue;
    const kindLabel = kind === 'selectordinal' ? 'selectordinal' : kind;
    for (const selector of refSet) {
      if (!locSet.has(selector)) {
        findings.push(mk('BRANCH_MISSING', locCode,
          `${kindLabel} 占位符 ${name} 缺少分支类别 ${selector}(参考语言 ${refCode})`,
          [wholeMessageMark(locSig)]));
      }
    }
    for (const selector of locSet) {
      if (!refSet.has(selector)) {
        findings.push(mk('BRANCH_EXTRA', locCode,
          `${kindLabel} 占位符 ${name} 比参考语言多出分支类别 ${selector}`,
          [branchMarkOf(locSig, name, kind, selector)]));
      }
    }
  }
}

/**
 * Whether all roles combined can be served by a single provided value.
 * wildcard (simple/tag) accepts anything; the numeric family
 * (number/plural/selectordinal) coexists; date/time/select are exclusive.
 */
function roleSetsSatisfiable(a, b) {
  let family = null;
  for (const role of new Set([...a, ...b])) {
    if (role === 'wildcard' || role === 'tag') continue;
    if (role === 'number' || role === 'plural' || role === 'selectordinal') {
      if (family && family !== 'numeric') return false;
      family = 'numeric';
    } else if (role === 'date' || role === 'time' || role === 'select') {
      if (family && family !== role) return false;
      family = role;
    }
  }
  return true;
}

function sameArray(a, b) {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function displayMultiset(v) {
  const list = [];
  for (const k of v.roleKinds) {
    if (k.kind === 'number' || k.kind === 'date' || k.kind === 'time') list.push(k.kind);
    else if (k.kind === 'simple' || k.kind === 'tag') list.push('simple');
  }
  return list.sort();
}

function formatDisplay(v) {
  const kinds = v.roleKinds
    .filter(k => ['number', 'date', 'time', 'simple', 'tag'].includes(k.kind))
    .map(k => (k.style ? `${k.kind}(${k.style})` : k.kind));
  return kinds.length ? [...new Set(kinds)].join('+') : '普通插值';
}

function describeVarUses(v) {
  const parts = [];
  for (const k of v.roleKinds) {
    let label = k.kind;
    if (k.style) label += `(${k.style})`;
    parts.push(label);
  }
  return [...new Set(parts)].join(' + ') || '普通插值';
}

function pluralOffset(v) {
  const kind = v.roleKinds.find(k => k.kind === 'plural' || k.kind === 'selectordinal');
  return kind ? kind.offset || 0 : null;
}

function branchSelectorMap(sig, varName) {
  const out = {};
  for (const b of (sig.branches.get(varName) || [])) {
    if (!out[b.kind]) out[b.kind] = new Set();
    out[b.kind].add(b.selector);
  }
  return out;
}

function branchMarkOf(sig, varName, kind, selector) {
  const b = (sig.branches.get(varName) || []).find(x => x.kind === kind && x.selector === selector);
  return (b && b.mark) || wholeMessageMark(sig);
}

function wholeMessageMark(sig) {
  return sig.rootMark || { start: 0, end: 1 };
}

function sameMultiset(aSet, bSet) {
  const a = [...aSet].sort();
  const b = [...bSet].sort();
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function mk(code, locale, message, marks) {
  return {
    severity: SEVERITY[code] || 'warning',
    code,
    locale,
    message,
    marks: marks || [],
    markLocale: locale,
  };
}

function rollupStatus(findings) {
  if (findings.some(f => f.severity === 'error')) return 'error';
  if (findings.some(f => f.severity === 'warning')) return 'warning';
  if (findings.some(f => f.severity === 'info')) return 'info';
  return 'ok';
}

function valueTypeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch (_) {
    return String(v);
  }
}

function summarize(findings, keyCount, localeCount) {
  const bySeverity = { error: 0, warning: 0, info: 0 };
  const byCode = {};
  for (const f of findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
    byCode[f.code] = (byCode[f.code] || 0) + 1;
  }
  return {
    locales: localeCount,
    keys: keyCount,
    totalFindings: findings.length,
    errors: bySeverity.error,
    warnings: bySeverity.warning,
    infos: bySeverity.info,
    byCode,
  };
}

module.exports = { analyze, SEVERITY };
