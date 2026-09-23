import parserPkg from '@formatjs/icu-messageformat-parser';

const { parse, TYPE } = parserPkg;

/*
 * 节点类型:
 * 0 literal  1 argument  2 number  3 date  4 time
 * 5 select   6 plural    7 pound   8 tag
 */

const KIND_NAME = {
  [TYPE.argument]: 'argument',
  [TYPE.number]: 'number',
  [TYPE.date]: 'date',
  [TYPE.time]: 'time',
  [TYPE.select]: 'select',
  [TYPE.plural]: 'plural',
};

/** 把 AST 中的 style 归一化为可比较字符串 */
export function styleCanonical(style) {
  if (style == null) return null;
  if (typeof style === 'string') return style.trim();
  if (typeof style === 'object') {
    if (typeof style.pattern === 'string') return `::${style.pattern}`;
    if (Array.isArray(style.tokens)) {
      return (
        '::' +
        style.tokens
          .map((t) =>
            t.options && t.options.length ? `${t.stem}/${t.options.join('/')}` : t.stem
          )
          .join(' ')
      );
    }
  }
  return null;
}

export function kindLabel(kind) {
  return {
    argument: '简单占位符',
    number: 'number',
    date: 'date',
    time: 'time',
    plural: 'plural（复数）',
    selectordinal: 'selectordinal（序数）',
    select: 'select（选择）',
  }[kind] || kind;
}

function locOf(node) {
  const s = node?.location?.start;
  if (!s) return null;
  return { offset: s.offset, line: s.line, column: s.column };
}

/** 解析单条消息，返回 ok / ast / 错误定位 */
export function parseMessage(text) {
  try {
    const ast = parse(String(text), { captureLocation: true });
    return { ok: true, ast };
  } catch (err) {
    const loc = err.location
      ? {
          start: {
            offset: err.location.start.offset,
            line: err.location.start.line,
            column: err.location.start.column,
          },
          end: err.location.end
            ? {
                offset: err.location.end.offset,
                line: err.location.end.line,
                column: err.location.end.column,
              }
            : null,
        }
      : null;
    return {
      ok: false,
      errorCode: err.message || 'PARSE_ERROR',
      error: humanParseError(err.message),
      location: loc,
    };
  }
}

function humanParseError(code) {
  const map = {
    MISSING_OTHER_CLAUSE: 'plural/select 缺少必须的 other 分支',
    INVALID_ARGUMENT_TYPE: '无法识别的占位符类型（仅支持 number/date/time/plural/select/selectordinal）',
    EXPECT_ARGUMENT_CLOSING_BRACE: '缺少右花括号 }',
    UNCLOSED_ARGUMENT: '占位符未闭合',
    UNMATCHED_CLOSING_TAG: '闭合标签与开始标签不匹配',
    UNCLOSED_TAG: '标签未闭合',
    EMPTY_TAG: '空标签名',
    INVALID_TAG: '标签语法非法',
    INVALID_PLURAL_OFFSET: 'plural offset 非法',
    INVALID_SELECTOR: '分支选择器非法',
    EXPECT_SELECTOR: '缺少分支选择器',
    EXPECT_ARGUMENT: '缺少占位符名称',
    UNTERMINATED_QUOTED_STRING: '引号未闭合',
    INVALID_ESCAPE: '非法的转义字符',
  };
  return map[code] || `ICU 语法错误：${code}`;
}

/** 根据错误位置生成源代码片段与指示符 */
export function snippetAt(text, location, radius = 60) {
  if (!location?.start) return null;
  const { offset, line, column } = location.start;
  const src = String(text);
  const start = Math.max(0, offset - radius);
  const end = Math.min(src.length, (location.end?.offset ?? offset) + radius);
  const excerpt = src.slice(start, end).replace(/\n/g, '\\n');
  const prefix = start > 0 ? '…' : '';
  const suffix = end < src.length ? '…' : '';
  const caretCol = prefix.length + (offset - start);
  const caret = ' '.repeat(caretCol) + '^';
  return {
    excerpt: `${prefix}${excerpt}${suffix}`,
    caret,
    line,
    column,
  };
}

/**
 * 从 AST 构建对比模型：
 *  - args: 全局占位符（含嵌套分支内的），name -> {kind, style, occurrences[]}
 *  - tags: 全局富文本标签名集合
 *  - shapes: 根节点序列（容器/标签/# 的嵌套结构）
 */
export function buildModel(ast) {
  const args = new Map();
  const tags = new Set();

  function recordArg(node, path) {
    const name = node.value;
    const kind =
      node.type === TYPE.plural
        ? node.pluralType === 'ordinal'
          ? 'selectordinal'
          : 'plural'
        : KIND_NAME[node.type];
    const style = node.type >= TYPE.number && node.type <= TYPE.time ? styleCanonical(node.style) : null;
    const loc = locOf(node);
    if (!args.has(name)) args.set(name, { name, occurrences: [] });
    args.get(name).occurrences.push({ kind, style, loc, path });
  }

  function walkElements(elements, trail) {
    return elements
      .filter((n) => n.type !== TYPE.literal)
      .map((n) => {
        const path = [...trail, describeNode(n)];
        if (n.type === TYPE.argument || n.type === TYPE.number || n.type === TYPE.date || n.type === TYPE.time || n.type === TYPE.select || n.type === TYPE.plural) {
          recordArg(n, path.join(' › '));
        }
        if (n.type === TYPE.plural || n.type === TYPE.select) {
          const options = {};
          for (const [selector, opt] of Object.entries(n.options)) {
            options[selector] = walkElements(opt.value, [...path, `[${selector}]`]);
          }
          return {
            shape: 'container',
            name: n.value,
            kind:
              n.type === TYPE.select
                ? 'select'
                : n.pluralType === 'ordinal'
                  ? 'selectordinal'
                  : 'plural',
            offset: n.offset || 0,
            options,
            loc: locOf(n),
            path: path.join(' › '),
          };
        }
        if (n.type === TYPE.tag) {
          tags.add(n.value);
          return {
            shape: 'tag',
            name: n.value,
            children: walkElements(n.children, [...path, `<${n.value}>`]),
            loc: locOf(n),
            path: path.join(' › '),
          };
        }
        if (n.type === TYPE.pound) {
          return { shape: 'pound', loc: locOf(n), path: path.join(' › '), trail: trail.join(' › ') };
        }
        // 普通/类型化占位符：结构比较交给全局 args，这里保留占位
        return {
          shape: 'arg',
          name: n.value,
          kind: KIND_NAME[n.type],
          loc: locOf(n),
          path: path.join(' › '),
        };
      });
  }

  const shapes = walkElements(ast, []);

  // 单条消息内部同名占位符的类型/样式冲突
  const localConflicts = [];
  for (const arg of args.values()) {
    const kinds = new Set(arg.occurrences.map((o) => o.kind));
    if (kinds.size > 1) {
      localConflicts.push({
        severity: 'error',
        code: 'LOCAL_TYPE_CONFLICT',
        message: `占位符 {${arg.name}} 在同一条消息中被声明为不同类型`,
        actual: arg.occurrences.map((o) => kindLabel(o.kind)).join(' / '),
        location: arg.occurrences[0]?.loc,
      });
      continue;
    }
    const styles = new Set(arg.occurrences.map((o) => o.style ?? ''));
    if (styles.size > 1) {
      localConflicts.push({
        severity: 'warning',
        code: 'LOCAL_STYLE_CONFLICT',
        message: `占位符 {${arg.name}} 在同一条消息中的格式样式不一致`,
        actual: arg.occurrences.map((o) => o.style ?? '默认').join(' / '),
        location: arg.occurrences[0]?.loc,
      });
    }
  }

  return { args, tags, shapes, localConflicts };
}

function describeNode(n) {
  if (n.type === TYPE.plural) return `${n.pluralType === 'ordinal' ? 'selectordinal' : 'plural'}(${n.value})`;
  if (n.type === TYPE.select) return `select(${n.value})`;
  if (n.type === TYPE.tag) return `<${n.value}>`;
  if (n.type === TYPE.pound) return '#';
  return `{${n.value}}`;
}

/** 对比两个 locale 的模型，产出 findings（localeCode 表示目标语言） */
export function compareModels(baseModel, targetModel, localeCode) {
  const findings = [];
  const push = (f) => findings.push({ locale_code: localeCode, ...f });

  // ---------- 1. 全局占位符 ----------
  for (const [name, a] of baseModel.args) {
    const b = targetModel.args.get(name);
    const aKinds = new Set(a.occurrences.map((o) => o.kind));
    const aStyles = new Set(a.occurrences.map((o) => o.style ?? ''));
    if (!b) {
      push({
        severity: 'error',
        code: 'ARG_MISSING',
        message: `缺少占位符 {${name}}（${[...aKinds].map(kindLabel).join('、')}）`,
        detail: a.occurrences.map((o) => o.path).join('；') || null,
        expected: [...aKinds].join('|'),
        actual: null,
        location: null,
      });
      continue;
    }
    const bKinds = new Set(b.occurrences.map((o) => o.kind));
    const bStyles = new Set(b.occurrences.map((o) => o.style ?? ''));
    const kindMismatch = [...aKinds].some((k) => !bKinds.has(k)) || [...bKinds].some((k) => !aKinds.has(k));
    if (kindMismatch) {
      push({
        severity: 'error',
        code: 'TYPE_CONFLICT',
        message: `占位符 {${name}} 类型冲突`,
        expected: [...aKinds].map(kindLabel).join('、'),
        actual: [...bKinds].map(kindLabel).join('、'),
        location: b.occurrences[0]?.loc ?? null,
      });
    } else {
      const styleMismatch = [...aStyles].some((s) => !bStyles.has(s)) || [...bStyles].some((s) => !aStyles.has(s));
      if (styleMismatch) {
        push({
          severity: 'warning',
          code: 'STYLE_CONFLICT',
          message: `占位符 {${name}} 格式样式不一致`,
          expected: [...aStyles].map((s) => s || '（默认）').join('、'),
          actual: [...bStyles].map((s) => s || '（默认）').join('、'),
          location: b.occurrences[0]?.loc ?? null,
        });
      }
    }
  }
  for (const [name, b] of targetModel.args) {
    if (!baseModel.args.has(name)) {
      push({
        severity: 'warning',
        code: 'ARG_EXTRA',
        message: `存在基准语言中没有的占位符 {${name}}（${[...new Set(b.occurrences.map((o) => o.kind))].map(kindLabel).join('、')}）`,
        expected: null,
        actual: [...new Set(b.occurrences.map((o) => o.kind))].join('|'),
        location: b.occurrences[0]?.loc ?? null,
      });
    }
  }

  // ---------- 2. 富文本标签 ----------
  for (const name of baseModel.tags) {
    if (!targetModel.tags.has(name)) {
      push({
        severity: 'warning',
        code: 'TAG_MISSING',
        message: `缺少富文本标签 <${name}>`,
      });
    }
  }
  for (const name of targetModel.tags) {
    if (!baseModel.tags.has(name)) {
      push({
        severity: 'warning',
        code: 'TAG_EXTRA',
        message: `存在基准语言中没有的富文本标签 <${name}>`,
      });
    }
  }

  // ---------- 3. 嵌套结构（容器 / # / 标签嵌套） ----------
  compareSequences(baseModel.shapes, targetModel.shapes, '', push);

  return findings;
}

function alignKey(el) {
  if (el.shape === 'container') return `C:${el.kind}:${el.name}`;
  if (el.shape === 'tag') return `T:${el.name}`;
  if (el.shape === 'pound') return '#';
  return `A:${el.name}`;
}

function takeFirst(list, key) {
  const idx = list.findIndex((el) => alignKey(el) === key);
  if (idx === -1) return null;
  return list.splice(idx, 1)[0];
}

function compareSequences(baseEls, tgtEls, trail, push) {
  const tgtPool = [...tgtEls];

  for (const b of baseEls) {
    if (b.shape === 'arg') continue; // 占位符已在全局检查
    const t = takeFirst(tgtPool, alignKey(b));
    if (!t) {
      if (b.shape === 'container') {
        push({
          severity: 'error',
          code: 'CONTAINER_MISSING',
          message: `缺少 ${kindLabel(b.kind)} 容器 {${b.name}}，嵌套结构不一致`,
          detail: b.path || null,
          location: b.loc,
        });
      } else if (b.shape === 'tag') {
        // 标签缺失已在全局检查
      } else if (b.shape === 'pound') {
        push({
          severity: 'warning',
          code: 'POUND_MISSING',
          message: `复数分支中缺少 #（当前数量占位）`,
          detail: b.trail || null,
          location: b.loc,
        });
      }
      continue;
    }

    if (b.shape === 'container' && t.shape === 'container') {
      compareContainers(b, t, push);
    } else if (b.shape === 'tag' && t.shape === 'tag') {
      compareSequences(b.children, t.children, b.path || trail, push);
    }
  }

  for (const extra of tgtPool) {
    if (extra.shape === 'container') {
      push({
        severity: 'warning',
        code: 'CONTAINER_EXTRA',
        message: `存在基准语言中没有的 ${kindLabel(extra.kind)} 容器 {${extra.name}}`,
        detail: extra.path || null,
        location: extra.loc,
      });
    } else if (extra.shape === 'pound') {
      push({
        severity: 'warning',
        code: 'POUND_EXTRA',
        message: `基准语言对应分支没有 #，但该语言在分支内使用了 #`,
        detail: extra.trail || null,
        location: extra.loc,
      });
    }
  }
}

function compareContainers(b, t, push) {
  if (b.kind !== t.kind) {
    push({
      severity: 'error',
      code: 'TYPE_CONFLICT',
      message: `占位符 {${b.name}} 的分支类型冲突`,
      expected: kindLabel(b.kind),
      actual: kindLabel(t.kind),
      location: t.loc,
    });
    return;
  }

  if (b.kind !== 'select' && b.offset !== t.offset) {
    push({
      severity: 'warning',
      code: 'PLURAL_OFFSET_CONFLICT',
      message: `plural {${b.name}} 的 offset 不一致`,
      expected: String(b.offset),
      actual: String(t.offset),
      location: t.loc,
    });
  }

  const isSelect = b.kind === 'select';
  for (const selector of Object.keys(b.options)) {
    if (!(selector in t.options)) {
      if (selector === 'other') {
        push({
          severity: 'error',
          code: isSelect ? 'SELECT_OTHER_MISSING' : 'PLURAL_OTHER_MISSING',
          message: `${kindLabel(b.kind)} {${b.name}} 缺少 other 分支`,
          location: t.loc,
        });
      } else if (isSelect) {
        push({
          severity: 'error',
          code: 'SELECT_OPTION_MISSING',
          message: `select {${b.name}} 缺少分支 "${selector}"`,
          detail: t.path || null,
          location: t.loc,
        });
      } else if (/^=\d+$/.test(selector)) {
        push({
          severity: 'warning',
          code: 'EXACT_BRANCH_MISSING',
          message: `plural {${b.name}} 缺少精确匹配分支 ${selector}`,
          detail: t.path || null,
          location: t.loc,
        });
      } else {
        push({
          severity: 'warning',
          code: 'PLURAL_CATEGORY_MISSING',
          message: `plural {${b.name}} 缺少复数类别分支 "${selector}"`,
          detail: t.path || null,
          location: t.loc,
        });
      }
    }
  }
  for (const selector of Object.keys(t.options)) {
    if (!(selector in b.options)) {
      push({
        severity: 'warning',
        code: isSelect ? 'SELECT_OPTION_EXTRA' : 'PLURAL_CATEGORY_EXTRA',
        message: `${kindLabel(b.kind)} {${b.name}} 多出基准语言没有的分支 "${selector}"`,
        detail: t.path || null,
        location: t.loc,
      });
    }
  }

  for (const selector of Object.keys(b.options)) {
    if (selector in t.options) {
      compareSequences(b.options[selector], t.options[selector], `${b.path} › [${selector}]`, push);
    }
  }
}
