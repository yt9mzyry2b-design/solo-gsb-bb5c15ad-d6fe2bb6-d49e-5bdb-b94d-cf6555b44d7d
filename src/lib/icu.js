'use strict';

/**
 * ICU MessageFormat parsing, signature extraction and rendering.
 * Built on @formatjs/icu-messageformat-parser and intl-messageformat.
 */

const parser = require('@formatjs/icu-messageformat-parser');
const { IntlMessageFormat } = require('intl-messageformat');

const { TYPE } = parser;

const FORMAT_LABELS = {
  [TYPE.literal]: 'literal',
  [TYPE.argument]: 'simple',
  [TYPE.number]: 'number',
  [TYPE.date]: 'date',
  [TYPE.time]: 'time',
  [TYPE.select]: 'select',
  [TYPE.plural]: 'plural',
  [TYPE.pound]: 'pound',
  [TYPE.tag]: 'tag',
};

/** Human friendly explanation for parser error codes. */
function explainParserError(code) {
  const table = {
    EXPECT_ARGUMENT_CLOSING_BRACE: '缺少参数闭合大括号 “}”',
    EXPECT_ARGUMENT_OPEN_BRACE: '应出现参数起始大括号 “{”',
    EXPECT_PLURAL_ARGUMENT_OPEN_BRACE: 'plural 分支内缺少 “{”',
    EXPECT_PLURAL_CLOSE_BRACE: 'plural 分支缺少闭合 “}”',
    EXPECT_PLURAL_ARGUMENT_SELECTOR: 'plural 分支选择器无效(如 one/other/=0)',
    EXPECT_SELECT_ARGUMENT_CLOSING_BRACE: 'select 分支缺少闭合 “}”',
    EXPECT_SELECT_ARGUMENT_OPEN_BRACE: 'select 分支内缺少 “{”',
    EXPECT_SELECT_ARGUMENT_SELECTOR: 'select 分支缺少选择器',
    INVALID_ARGUMENT_TYPE: '不支持的占位符类型(应为 number/date/time/plural/select/selectordinal)',
    INVALID_PLURAL_OFFSET: 'plural offset 取值无效',
    MISSING_OTHER_CLAUSE: 'plural/select 缺少必需的 other 分支',
    MISSING_SELECT_CLAUSE: 'select 至少需要一个分支',
    UNCLOSED_ARGUMENT: '参数未闭合,缺少 “}”',
    UNCLOSED_QUOTED_STRING: "引号包裹的文本未闭合(缺少 ')",
    UNMATCHED_CLOSING_TAG: '存在未匹配的闭合标签',
    UNCLOSED_TAG: '标签未闭合',
    INVALID_TAG: '标签名称非法',
    DUPLICATE_PLURAL_SELECTOR: 'plural 分支选择器重复',
    DUPLICATE_SELECT_SELECTOR: 'select 分支选择器重复',
    INVALID_SELECTOR: '分支选择器非法',
    UNEXPECTED_TOKEN: '出现无法识别的字符或 token',
  };
  return table[code] || `ICU 语法错误(${code})`;
}

/**
 * Parse one ICU message.
 * @returns {{ok:true, ast:object[]} | {ok:false, error:object}}
 *   error: { code, message, hint, start:{offset,line,column}, end }
 */
function parseMessage(source) {
  try {
    const ast = parser.parse(source, { captureLocation: true, shouldParseSkeletons: false });
    return { ok: true, ast };
  } catch (err) {
    let code = (err && (err.message || '')).toString();
    let location = err && err.location;
    // Some parser versions throw the SyntaxError without a location; retry
    // lenient parsing only to recover more of the AST for the report.
    let recoveredAst = null;
    try {
      recoveredAst = parser.parse(source, {
        captureLocation: true,
        requiresOtherClause: false,
      });
    } catch (_) {
      recoveredAst = null;
    }
    return {
      ok: false,
      error: {
        code,
        message: code,
        hint: explainParserError(code),
        start: (location && location.start) || { offset: 0, line: 1, column: 1 },
        end: location && location.end,
      },
      recoveredAst,
    };
  }
}

function styleName(node, source) {
  const s = node.style;
  if (s == null) return null;
  if (typeof s === 'string') return s;
  // Skeleton node: recover its literal text from the source span.
  if (s && typeof s === 'object' && s.location && source != null) {
    const start = s.location.start.offset;
    const end = s.location.end ? s.location.end.offset : start;
    return source.slice(start, end).trim() || 'skeleton';
  }
  if (s && s.type === parser.SKELETON_TYPE.numberDateTime) return 'skeleton';
  return s ? String(s) : null;
}

function locMark(loc, fallbackLen) {
  if (!loc || !loc.start) return null;
  const start = loc.start.offset;
  const end = loc.end ? loc.end.offset : start + (fallbackLen != null ? fallbackLen : 1);
  return { start, end: Math.max(end, start + 1) };
}

/**
 * Roles classify what kind of value a placeholder occurrence requires:
 *   wildcard      simple {x} or rich-text tag (<x>) — accepts anything
 *   number        {x, number[, style]}
 *   date          {x, date[, style]}
 *   time          {x, time[, style]}
 *   plural        cardinal plural controller (numeric)
 *   selectordinal ordinal plural controller (numeric)
 *   select        string-choice controller
 *
 * Numeric display (number) and numeric control (plural*) coexist on one
 * variable freely; date/time/select do not.
 */
const ROLE_COMPAT = {
  wildcard:  ['wildcard', 'number', 'date', 'time', 'plural', 'selectordinal', 'select', 'tag'],
  number:    ['wildcard', 'number', 'plural', 'selectordinal'],
  date:      ['wildcard', 'date'],
  time:      ['wildcard', 'time'],
  plural:    ['wildcard', 'number', 'plural', 'selectordinal'],
  selectordinal: ['wildcard', 'number', 'plural', 'selectordinal'],
  select:    ['wildcard', 'select'],
  tag:       ['wildcard'],
};

function roleOfKind(kind) {
  switch (kind) {
    case 'simple': return 'wildcard';
    case 'number': return 'number';
    case 'date': return 'date';
    case 'time': return 'time';
    case 'plural': return 'plural';
    case 'selectordinal': return 'selectordinal';
    case 'select': return 'select';
    case 'tag': return 'tag';
    default: return 'wildcard';
  }
}

/** Can two occurrences of the same variable be satisfied by one value? */
function rolesCompatible(a, b) {
  const list = ROLE_COMPAT[a] || ['wildcard'];
  return list.includes(b);
}

/**
 * Extract a structural signature from a parsed AST.
 *
 * Signature:
 * {
 *   vars: Map<name, { name, roleKinds:[{kind,role,style,pluralType,mark}],
 *                     roles:Set, displayKinds:[...], controlKinds:[...],
 *                     paths:Set, occurrences:[Mark] }>,
 *   branches: Map<name, [{ kind, selector, mark, hasPound }]>,
 *   pounds: [{ mark, boundVar, valid }],
 *   rootMark
 * }
 */
function extractSignature(ast, source) {
  const vars = new Map();
  const branches = new Map();
  const pounds = [];
  let rootLoc = null;

  function ensureVar(name) {
    if (!vars.has(name)) {
      vars.set(name, {
        name,
        roleKinds: [],
        roles: new Set(),
        displayKinds: [],
        controlKinds: [],
        paths: new Set(),
        occurrences: [],
        offset: 0,
      });
    }
    return vars.get(name);
  }

  function formatOf(node) {
    if (node.type === TYPE.argument) return 'simple';
    return FORMAT_LABELS[node.type] || 'unknown';
  }

  function recordKind(v, kind, style, pluralType, mark, offset) {
    const role = roleOfKind(kind);
    v.roleKinds.push({ kind, role, style: style || null, pluralType: pluralType || null, mark, offset: offset || 0 });
    v.roles.add(role);
    if (kind === 'number' || kind === 'date' || kind === 'time') v.displayKinds.push({ kind, style });
    if (kind === 'plural' || kind === 'selectordinal' || kind === 'select') v.controlKinds.push({ kind, pluralType });
  }

  function register(node, ctx) {
    const v = ensureVar(node.value);
    const kind = formatOf(node);
    const mark = locMark(node.location, node.value.length);
    recordKind(v, kind, styleName(node, source), node.pluralType || null, mark);
    v.occurrences.push(mark);
    v.paths.add(ctx.path.join('/'));
  }

  /** Stack tokens describe current nesting containers, e.g. "plural(count)/one". */
  function walk(nodes, ctx) {
    // ctx: { path: string[], pluralStack: [{varName, branchSelector}...] }
    for (const node of nodes) {
      if (node.location && rootLoc == null) rootLoc = node.location;

      if (node.type === TYPE.pound) {
        const pluralCtx = ctx.pluralStack.length
          ? ctx.pluralStack[ctx.pluralStack.length - 1]
          : null;
        const mark = locMark(node.location, 1);
        pounds.push({
          mark,
          boundVar: pluralCtx ? pluralCtx.varName : null,
          valid: Boolean(pluralCtx),
        });
        if (pluralCtx) pluralCtx.hasPound = true;
        continue;
      }

      if (node.type === TYPE.literal) continue;

      if (node.type === TYPE.plural || node.type === TYPE.select) {
        const name = node.value;
        const v = ensureVar(name);
        const kind = node.type === TYPE.plural
          ? (node.pluralType === 'ordinal' ? 'selectordinal' : 'plural')
          : 'select';
        const mark = locMark(node.location, name.length);
        recordKind(v, kind, null, node.pluralType || null, mark, node.offset || 0);
        v.occurrences.push(mark);
        v.paths.add(ctx.path.join('/'));

        const branchList = [];
        for (const [selector, option] of Object.entries(node.options || {})) {
          const optLoc = option.location;
          const mark = branchHeadMark(optLoc, node.location, selector);
          branchList.push({ kind, selector, mark });
          const token = `${kind}(${name})/${selector}`;
          const childCtx = {
            path: ctx.path.concat(token),
            pluralStack: ctx.pluralStack,
          };
          if (node.type === TYPE.plural) {
            childCtx.pluralStack = ctx.pluralStack.concat([
              { varName: name, branchSelector: selector, hasPound: false },
            ]);
          }
          walk(option.value || [], childCtx);
          if (node.type === TYPE.plural && childCtx.pluralStack.length) {
            const frame = childCtx.pluralStack[childCtx.pluralStack.length - 1];
            branchList[branchList.length - 1].hasPound = frame.hasPound;
          }
        }
        branches.set(name, branchList);

        const pluralKind = v.roleKinds.find(k => k.kind === kind);
        if (pluralKind) v.offset = pluralKind.offset || 0;
        continue;
      }

      if (node.type === TYPE.tag) {
        register(node, ctx);
        walk(node.children || [], {
          path: ctx.path.concat(`tag(${node.value})`),
          pluralStack: ctx.pluralStack,
        });
        continue;
      }

      // simple / number / date / time
      register(node, ctx);
    }
  }

  walk(ast, { path: [], pluralStack: [] });

  return {
    vars,
    branches,
    pounds,
    rootMark: rootLoc ? locMark(rootLoc, 1) : { start: 0, end: 1 },
  };
}

/**
 * Locate a branch selector within the raw message when possible.
 * option.location covers the message inside braces; the selector sits a few
 * chars before it ("one{" -> inside starts right after "{").
 */
function branchHeadMark(optLoc, nodeLoc, selector) {
  if (optLoc && optLoc.start) {
    const braceOffset = optLoc.start.offset;
    return { start: Math.max(0, braceOffset - selector.length - 1), end: braceOffset - 1 };
  }
  if (nodeLoc && nodeLoc.start) return { start: nodeLoc.start.offset, end: nodeLoc.start.offset + 1 };
  return { start: 0, end: 1 };
}

/** Serialized, comparable view of a signature. */
function signatureToJSON(sig) {
  const vars = {};
  for (const [name, v] of sig.vars) {
    const kinds = v.roleKinds;
    vars[name] = {
      name,
      roles: [...v.roles].sort(),
      // First "primary" kind for display chips: prefer typed displays/controls.
      format: kinds.map(k => k.kind).find(k => k !== 'simple' && k !== 'tag') || (kinds[0] && kinds[0].kind) || 'simple',
      pluralType: (v.controlKinds.find(k => k.pluralType) || {}).pluralType || null,
      offset: v.offset || 0,
      style: (v.displayKinds[0] || {}).style || null,
      kinds: kinds.map(k => ({ kind: k.kind, style: k.style, pluralType: k.pluralType, offset: k.offset })),
      paths: [...v.paths].sort(),
      occurrences: v.occurrences,
    };
  }
  const branches = {};
  for (const [name, list] of sig.branches) {
    branches[name] = list.map(b => ({
      kind: b.kind,
      selector: b.selector,
      hasPound: Boolean(b.hasPound),
      mark: b.mark,
    }));
  }
  return { vars, branches, pounds: sig.pounds };
}

/**
 * Detect role conflicts between repeated occurrences of the same variable
 * inside a single message. number/plural* sharing one variable is legal and
 * common (display + control); date vs number, select vs plural etc. are not.
 */
function intraMessageConflicts(sig) {
  const findings = [];
  for (const [name, v] of sig.vars) {
    const kinds = v.roleKinds;
    let conflict = null;
    for (let i = 0; i < kinds.length && !conflict; i++) {
      for (let j = i + 1; j < kinds.length; j++) {
        if (!rolesCompatible(kinds[i].role, kinds[j].role)) {
          conflict = { first: kinds[i], second: kinds[j], i, j };
          break;
        }
      }
    }
    if (conflict) {
      findings.push({
        code: 'INTRA_TYPE_CONFLICT',
        varName: name,
        expected: formatKindDesc(conflict.first),
        actual: formatKindDesc(conflict.second),
        marks: [kinds[conflict.i].mark, kinds[conflict.j].mark].filter(Boolean),
      });
    }

    // Duplicate typed displays with different styles are always suspicious.
    const stylesByDisplay = new Map();
    for (const k of kinds) {
      if (k.kind === 'number' || k.kind === 'date' || k.kind === 'time') {
        const key = k.kind;
        const prev = stylesByDisplay.get(key);
        if (prev && prev.style !== k.style) {
          findings.push({
            code: 'INTRA_TYPE_CONFLICT',
            varName: name,
            expected: formatKindDesc(prev),
            actual: formatKindDesc(k),
            marks: [prev.mark, k.mark].filter(Boolean),
          });
          break;
        }
        if (!prev) stylesByDisplay.set(key, k);
      }
    }
  }
  return findings;
}

function formatKindDesc(k) {
  if (!k) return '?';
  if (k.kind === 'selectordinal') return 'selectordinal';
  if ((k.kind === 'number' || k.kind === 'date' || k.kind === 'time') && k.style) {
    return `${k.kind}:${k.style}`;
  }
  return k.kind;
}

/**
 * Render an ICU message. String inputs are coerced to proper JS types;
 * rich-text tags (<x>…) are wrapped automatically unless a wrapper is given.
 * @returns {{ok:true, output:string} | {ok:false, error:string}}
 */
function renderMessage(source, locale, rawValues) {
  let values = {};
  try {
    values = coerceValues(rawValues || {});
  } catch (e) {
    return { ok: false, error: `变量值不是合法 JSON:${e.message}` };
  }
  try {
    // Auto-supply wrappers for rich-text tags the caller did not define.
    for (const { tagName, selfClosing } of discoverTagNames(source)) {
      if (typeof values[tagName] !== 'function') {
        if (selfClosing) {
          values[tagName] = () => `<${tagName}/>`;
        } else {
          values[tagName] = (chunks) => `<${tagName}>${[].concat(chunks).join('')}</${tagName}>`;
        }
      }
    }
    const mf = new IntlMessageFormat(source, locale || 'en', undefined, {
      ignoreTag: false,
      requiresOtherClause: false,
    });
    return { ok: true, output: mf.format(values) };
  } catch (err) {
    return { ok: false, error: friendlyRenderError(err) };
  }
}

/** Best-effort list of rich-text tag names used in a message. */
function discoverTagNames(source) {
  const tags = [];
  // <foo>…</foo> open tags, </foo> close tags, <br/> self-closing tags.
  const re = /<(\/?)\s*([0-9A-Za-z][\w-]*)\s*(\/)?>/g;
  let m;
  while ((m = re.exec(source))) {
    const isClose = m[1] === '/';
    const selfClosing = Boolean(m[3]);
    if (!isClose) tags.push({ tagName: m[2], selfClosing });
  }
  return tags;
}

function friendlyRenderError(err) {
  const msg = (err && err.message) ? err.message : String(err);
  if (/Cannot (read|format)|undefined|The intl string context variable/i.test(msg)) {
    return `渲染失败:变量缺失或取值类型不匹配(${msg})`;
  }
  return `渲染失败:${msg}`;
}

/**
 * Convert sample values coming from the UI (strings) into proper JS types:
 * numbers for numeric strings, booleans, JSON objects/arrays, epoch ms for
 * date/time values are left to the caller via { "$type" } hints not needed —
 * numeric strings become numbers which ICU accepts for date/time too.
 */
function coerceValues(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v == null) continue;
    if (typeof v !== 'string') {
      out[k] = v;
      continue;
    }
    const s = v.trim();
    if (s === '') continue;
    if (s === 'true') { out[k] = true; continue; }
    if (s === 'false') { out[k] = false; continue; }
    if (/^-?\d+$/.test(s)) { out[k] = Number(s); continue; }
    if (/^-?\d+\.\d+$/.test(s)) { out[k] = Number(s); continue; }
    if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
      out[k] = JSON.parse(s);
      continue;
    }
    out[k] = v;
  }
  return out;
}

module.exports = {
  TYPE,
  FORMAT_LABELS,
  parseMessage,
  extractSignature,
  signatureToJSON,
  intraMessageConflicts,
  renderMessage,
  coerceValues,
  explainParserError,
};
