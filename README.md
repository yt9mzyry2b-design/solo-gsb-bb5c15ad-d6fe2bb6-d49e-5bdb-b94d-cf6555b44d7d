# LocaleContract

> 基于 **Node.js + SQLite** 的 ICU MessageFormat 多语言消息目录审查工具。
> 粘贴 / 上传各语言 JSON,自动解析嵌套的 `plural` / `select` / `selectordinal` 语法,
> 校验占位符、分支类别与嵌套结构的跨语言一致性,精确定位缺失、类型冲突和无法解析的位置;
> 填入示例变量即可实时预览渲染结果,并支持导出 **JSON / CSV** 审查报告。

![stack](https://img.shields.io/badge/node-%3E%3D20-green) ![db](https://img.shields.io/badge/SQLite-better--sqlite3-blue) ![icu](https://img.shields.io/badge/ICU-MessageFormat-orange)

---

## 功能特性

| 能力 | 说明 |
| --- | --- |
| 📥 多方式录入 | 直接粘贴 JSON 或上传 `.json` 文件,按语言代码(en / zh-CN / ja…)管理多个目录 |
| 🗂 嵌套扁平化 | 自动展平嵌套对象与数组(`page.title`、`list.0.label`),逐一比对每个消息键 |
| 🔍 ICU 结构解析 | 基于 `@formatjs/icu-messageformat-parser` 解析 `simple` / `number` / `date` / `time` / `plural` / `select` / `selectordinal` / 富文本标签,支持任意深度嵌套与 `offset:N` |
| ⚖️ 跨语言一致性校验 | 以选定的参考语言为基准,逐键比对(完整规则见下表) |
| 🎯 位置高亮 | 所有问题都带字符级 offset,在原始消息上以红 / 黄 / 青色高亮标出错误区间 |
| 🧪 示例变量预览 | 自动汇总消息涉及的占位符生成表单,数字字符串自动转型,逐语言调用 ICU 渲染 |
| 🗃 报告持久化 | 项目、语言、报告、问题明细、示例变量均存入 SQLite;可回看历史报告 |
| 📤 导出 | 一键导出机器可读的 JSON 全量报告或可在 Excel 中打开的 UTF‑8 BOM CSV |
| 🐳 容器交付 | 内置 Dockerfile 与 Compose,启动后浏览器直接访问 |

### 校验规则

| 级别 | 代码 | 触发条件 |
| --- | --- | --- |
| 🔴 错误 | `LOCALE_JSON_ERROR` | 语言文件不是合法 JSON(带行列信息) |
| 🔴 错误 | `KEY_MISSING` | 某语言缺少消息键 |
| 🔴 错误 | `VALUE_TYPE_INVALID` | 消息值不是字符串(数字 / 数组 / null 等) |
| 🔴 错误 | `PARSE_ERROR` | ICU 语法无法解析(未闭合、缺少 `other`、未知类型等),定位到具体行列与字符区间 |
| 🔴 错误 | `INTRA_TYPE_CONFLICT` | 同一消息内同名变量被赋予无法由同一个值满足的角色,如 `{d, date}` 与 `{d, number}`、`{g, select}` 与 `{g, plural}`;`{n, number}` 与 `{n, plural}` 共存(展示+控制同一数值)是合法的 |
| 🔴 错误 | `POUND_WITHOUT_PLURAL` | `#` 出现在 plural / selectordinal 分支之外(解析器对非 plural 内的 `#` 按字面量处理) |
| 🔴 错误 | `PLACEHOLDER_MISSING` | 参考语言使用的占位符在目标语言中缺失 |
| 🔴 错误 | `TYPE_CONFLICT` | 同名变量取值类型不兼容,如 `date` ↔ `number`,`plural`(cardinal)↔ `selectordinal`,`select` ↔ 数值类 |
| 🔴 错误 | `BRANCH_MISSING` | 相同控制类型的 `plural` / `selectordinal` / `select` 缺少分支类别(如缺 `one`、`=0`、某个 case) |
| 🔴 错误 | `NESTING_MISMATCH` | 占位符在两个语言中所处的嵌套容器路径不同(嵌套结构被改坏) |
| 🟡 警告 | `FORMAT_MISMATCH` | 同名变量展示/使用格式不同但取值可兼容,如 `number` ↔ 普通插值 `{x}`、`number` ↔ `number+plural`、`selectordinal` ↔ 普通插值 |
| 🟡 警告 | `PLACEHOLDER_EXTRA` | 目标语言多出参考语言没有的占位符 |
| 🟡 警告 | `STYLE_MISMATCH` | number/date/time 的样式不同(`short` → `long`、`::compact-short` 等 skeleton、货币样式) |
| 🟡 警告 | `OFFSET_MISMATCH` | plural 的 `offset:N` 不一致 |
| 🔵 提示 | `BRANCH_EXTRA` | 目标语言比参考语言多出分支类别 |
| 🔵 提示 | `EMPTY_MESSAGE` | 消息为空字符串 |

---

## 快速开始(容器)

需要 Docker 20.10+ 与 Compose v2。

```bash
# 构建并启动(前台可看日志)
docker compose up --build

# 或后台运行
docker compose up -d --build
```

启动后浏览器访问:

```
http://localhost:3000
```

SQLite 数据文件持久化在命名卷 `localecontract-data`(容器内 `/data`),
升级 / 重建容器不会丢失项目与报告。

修改宿主机映射端口(例如改为 8080),编辑 `docker-compose.yml` 的 `ports`:

```yaml
ports:
  - "8080:3000"
```

---

## 快速开始(本地 Node)

要求 **Node.js ≥ 20**(内置完整 ICU,保证多语言 plural 规则可用)。

```bash
npm install
npm start
# LocaleContract running at http://localhost:3000
```

可用环境变量:

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `LC_DATA_DIR` | `./data` | SQLite 数据库存放目录 |
| `LC_DB_FILE` | `$LC_DATA_DIR/localecontract.db` | 自定义数据库文件完整路径 |

---

## 使用流程

1. **新建项目** —— 例如「Web App 5.2 文案」。
2. **添加语言** —— 点击「＋ 添加语言」,填写语言代码,粘贴 JSON 或选择文件上传,保存。重复添加所有目标语言。
3. **选择参考语言** —— 下拉选择结构基准(默认为第一种语言)。
4. **运行一致性校验** —— 系统解析全部 ICU 消息并汇总问题:
   - 顶部显示错误 / 警告 / 提示数量;
   - 左下「问题清单」可按级别、语言、关键字过滤;
   - 右下「消息键」用彩色语言标签快速定位有问题的键;
   - 点击任意条目,右侧详情区在原始文案上**高亮字符区间**,并显示占位符类型、分支类别和嵌套结构树。
5. **填写示例变量并预览** —— 详情页底部自动生成变量表单(纯数字自动转为 number,日期可填毫秒时间戳),输入后实时在任意语言间切换渲染结果。示例按项目保存,可复用。
6. **导出报告** —— 点击「导出 JSON / CSV 报告」;历史报告可在下拉框中回看。

### 示例目录

`en`:

```json
{
  "greeting": "Hello {name}!",
  "items": "{count, plural, offset:1 =0{no items} one{# item} other{# items}}",
  "notice": "{gender, select, female {{count, plural, one {her # file} other {her # files}}} other {{count, plural, one {their # file} other {their # files}}}}"
}
```

`zh`:

```json
{
  "greeting": "你好 {name}!",
  "items": "{count, plural, other{# 个文件}}",
  "notice": "{gender, select, other{{count, plural, other{他们的 # 个文件}}}}"
}
```

对这组文件运行校验,会得到:分支缺失(`=0`、`one`)、`offset` 不一致、`notice` 的嵌套路径缺失等结果。

---

## HTTP API

所有接口均返回 JSON。

### 项目

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/projects` | 项目列表 |
| POST | `/api/projects` | 新建项目 `{name}` |
| GET | `/api/projects/:id` | 项目详情(语言、最近 20 份报告) |
| PUT | `/api/projects/:id` | 更新名称 / 参考语言 `{name, refLocale}` |
| DELETE | `/api/projects/:id` | 删除项目(级联删除全部数据) |

### 语言目录

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/projects/:id/locales` | 语言列表 |
| POST | `/api/projects/:id/locales` | 新增语言 `{code,label,content}` |
| PUT | `/api/projects/:id/locales/:code` | 更新语言 JSON |
| DELETE | `/api/projects/:id/locales/:code` | 删除语言 |

### 校验与报告

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/projects/:id/analyze` | 运行校验;可带 `{refLocale}`,也可临时提交 `{locales:[{code,label,content}]}`(会同时保存) |
| GET | `/api/projects/:id/reports` | 历史报告 |
| GET | `/api/projects/:id/reports/:rid` | 读取完整分析结果 |
| GET | `/api/projects/:id/reports/:rid/export?format=json\|csv` | 下载报告 |

### 预览与示例

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/preview` | 实时渲染 `{message, locale, values}` |
| GET | `/api/projects/:id/samples` | 全部已保存示例变量 |
| PUT | `/api/projects/:id/samples/:keyPath` | 保存某消息的示例变量 |

---

## 项目结构

```
.
├── Dockerfile               # node:20-slim + native 构建回退
├── docker-compose.yml       # 一键启动 + 数据卷 + 健康检查
├── package.json
├── src
│   ├── server.js            # Express 路由 / 持久化编排
│   ├── config.js            # 环境变量配置
│   ├── db.js                # SQLite 初始化与表结构
│   └── lib
│       ├── icu.js           # ICU 解析、结构签名、渲染(intl-messageformat)
│       ├── catalog.js       # JSON 解析与嵌套扁平化
│       ├── analyzer.js      # 跨语言比对规则引擎
│       └── report.js        # JSON / CSV 导出
├── public
│   ├── index.html           # 单页界面
│   ├── styles.css
│   └── app.js               # 前端状态 / 高亮 / 预览
├── examples
│   ├── en.json              # 示例:含 number/plural/selectordinal/嵌套 select+plural/skeleton
│   └── zh-CN.json           # 示例:故意存在分支缺失、样式不一致等问题
└── test
    └── analyzer.test.js     # node --test 单元测试
```

### 数据模型(SQLite)

- `projects` —— 审查项目(含参考语言)
- `locales` —— 每个项目下各语言的原始 JSON
- `reports` —— 每次校验的完整结果 JSON 与汇总
- `findings` —— 报告下的问题明细(键、语言、级别、代码、描述、字符区间)
- `samples` —— 每个消息键保存的示例变量

---

## 开发

```bash
npm run dev     # node --watch 热重启
npm test        # node --test 运行分析引擎单元测试
```

## 技术说明与边界

- 解析器默认遵循 ICU 规范:plural / select 必须包含 `other` 分支;缺失时按
  `PARSE_ERROR (MISSING_OTHER_CLAUSE)` 报告,并指出位置。
- `#` 是 plural / selectordinal 分支内对当前数值的简写;普通文本中的 `#`
  按字面量处理,不会误报。
- 数字样式支持 ICU 内置名称(`integer` / `percent` / `currency`…)、
  `short` / `long` 等日期样式以及 skeleton。
- 富文本标签 `<x>...</x>` 作为带格式的占位符参与一致性比对,预览时输出包裹后的标签文本。
- 多语言 plural 规则依赖 Node 全 ICU(Node 20 官方镜像默认满足);Alpine 等
  small-icu 环境可能导致部分语言分支判断异常,因此官方镜像基于 `node:20-slim`。

## License

MIT
