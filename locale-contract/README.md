# 📜 LocaleContract

基于 **Node.js + Express + SQLite** 的网页工具，用于审查 **ICU MessageFormat** 多语言消息目录（i18n catalog）。

粘贴或上传各语言 JSON 后，系统会解析嵌套的 `plural / select / selectordinal` 语法，校验各语言之间的**占位符、分支类别与嵌套结构**是否一致，标出缺失、类型冲突和无法解析的位置；填入示例变量即可预览真实渲染结果，并可导出 **JSON / CSV** 审查报告。

![flow](https://img.shields.io/badge/stack-Node.js%20%7C%20Express%20%7C%20SQLite%20%7C%20FormatJS-4f8cff)

---

## ✨ 功能特性

- **多项目 / 多语言管理**：多个独立审查项目，每个项目包含任意数量的语言目录
- **两种导入方式**
  - 直接粘贴 JSON（手动指定语言代码，如 `en`、`zh-CN`、`pt-BR`）
  - 批量上传 `.json` 文件（支持多选 / 拖拽，文件名 `en.json`、`zh-CN.json` 自动识别语言代码）
- **嵌套 JSON 扁平化**：`{ "app": { "title": "..." } }` 自动展开为 `app.title`，数组按下标 `items[0]` 展开
- **ICU MessageFormat 深度解析**（基于 [`@formatjs/icu-messageformat-parser`](https://formatjs.io/)）
  - 简单占位符 `{name}`
  - 类型化占位符 `{count, number, ::currency/USD}`、`{date, date, short}`、`{time, time, medium}`
  - `plural`（含 `offset`、精确匹配 `=0` 与 CLDR 类别 `zero/one/two/few/many/other`）
  - `selectordinal`、`select`
  - 富文本标签 `<link>{text}</link>`、`#` 数量占位
- **跨语言一致性校验**
  - 🔴 消息键缺失 / 占位符缺失 / 占位符类型冲突
  - 🔴 `plural` / `select` 缺少必须的 `other` 分支、`select` 缺少命名分支
  - 🔴 嵌套容器丢失（例如一边用 `plural`，另一边退化成简单占位符）
  - 🔴 ICU 语法无法解析（未闭合的括号、标签不匹配等），并给出**行列号 + 源码片段 + `^` 指示符**
  - 🟡 占位符格式样式不一致（如 `currency/USD` vs 默认 number）
  - 🟡 复数类别 / 精确分支 / select 分支缺失或多余、`#` 缺失、`offset` 不一致
  - 🟡 富文本标签缺失 / 多余、基准语言之外多出的键
  - 🔵 非字符串值（数字 / 布尔 / null / 空对象等）提示
- **示例变量预览**：按占位符类型自动生成表单（number 数字框、date/time 日期框），实时渲染各语言结果；富文本标签自动包裹输出
- **报告导出**：结构化 **JSON** 报告 + Excel 友好的 **CSV**（UTF-8 BOM）
- **持久化**：所有项目、目录与审查结果存入 SQLite（`better-sqlite3`），容器重启不丢失

---

## 🚀 快速开始

### 方式一：Docker Compose（推荐）

```bash
cd locale-contract
docker compose up -d --build
```

启动后浏览器访问：

> **http://localhost:3000**

数据保存在 Docker 卷 `lc-data`（容器内 `/data/localecontract.db`）。停止 / 更新：

```bash
docker compose down        # 停止（保留数据）
docker compose pull 2>/dev/null; docker compose up -d --build
```

如希望把数据库放到宿主机目录，可把 `docker-compose.yml` 中的卷改为绑定挂载：

```yaml
volumes:
  - ./data:/data
```

### 方式二：Docker

```bash
docker build -t locale-contract .
docker run -d --name locale-contract -p 3000:3000 -v lc-data:/data locale-contract
```

### 方式三：本地 Node.js 运行

要求 **Node.js ≥ 20**。

```bash
cd locale-contract
npm install
npm start
# → LocaleContract running at http://localhost:3000
```

开发模式（文件改动自动重启）：`npm run dev`

---

## 🧭 使用指南

1. 点击右上角 **「加载示例」**，会创建一个包含 `en / zh-CN / ja` 三个语言的演示项目，其中故意埋入了缺失占位符、类型冲突、无法解析的语法、缺失分支等各类问题。
2. 或点击 **「＋ 新建项目」**，然后 **「＋ 添加语言」**：
   - **粘贴 JSON**：输入语言代码 + 目录内容；
   - **上传文件**：多选 `en.json`、`zh-CN.json` 等文件，拖拽亦可。
3. 每次导入后系统会**自动重跑全量审查**，也可以在「语言目录」标签页手动重跑。
4. 在顶部 **基准语言** 下拉中切换对比基准（默认自动取第一个可解析的语言）。
5. 右侧 **审查问题** 面板按 错误 / 警告 / 提示 分级，支持按语言、级别、关键字过滤；点击任意问题可打开该消息键的详情。
6. 在消息详情中：
   - 并排查看各语言原文，无法解析的消息会标红并显示错误与位置；
   - 底部 **变量预览渲染** 选择语言、填写变量（或点「填入示例值」），实时查看渲染结果。
7. 点击右上角 **导出 JSON / 导出 CSV** 下载完整报告。

### 支持的输入格式

```json
{
  "app": {
    "unread": "{count, plural, offset:0 =0 {No messages} one {# new message} other {# new messages}}",
    "login":  "{gender, select, male {He logged in} female {She logged in} other {They logged in}}",
    "rank":   "{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}",
    "price":  "Total {amount, number, ::currency/USD}",
    "note":   "See <link>terms</link> by {d, date, medium}"
  }
}
```

---

## 🔎 审查规则一览

| 级别 | 代码 | 含义 |
| --- | --- | --- |
| 🔴 error | `KEY_MISSING` | 目标语言缺少基准语言存在的消息键 |
| 🔴 error | `ARG_MISSING` | 缺少占位符（含嵌套分支内部使用的变量） |
| 🔴 error | `TYPE_CONFLICT` | 同名占位符类型冲突（`number` vs `date`、`plural` vs `selectordinal` 等） |
| 🔴 error | `CONTAINER_MISSING` | 缺少 `plural/select` 容器，嵌套结构不一致 |
| 🔴 error | `PLURAL_OTHER_MISSING` / `SELECT_OTHER_MISSING` | 缺少必须的 `other` 分支 |
| 🔴 error | `SELECT_OPTION_MISSING` | 缺少 `select` 的命名分支 |
| 🔴 error | `PARSE_ERROR` | ICU 语法无法解析（附行列号与源码片段） |
| 🔴 error | `LOCAL_TYPE_CONFLICT` | 同一条消息中同名占位符被声明为不同类型 |
| 🟡 warning | `KEY_EXTRA` / `ARG_EXTRA` | 多出基准语言没有的键 / 占位符 |
| 🟡 warning | `STYLE_CONFLICT` | number/date/time 的格式样式（skeleton / 命名样式）不一致 |
| 🟡 warning | `PLURAL_CATEGORY_MISSING` / `EXACT_BRANCH_MISSING` | 缺少复数类别或 `=n` 精确分支 |
| 🟡 warning | `PLURAL_CATEGORY_EXTRA` / `SELECT_OPTION_EXTRA` | 多出基准语言没有的分支 |
| 🟡 warning | `POUND_MISSING` / `POUND_EXTRA` | 复数分支内 `#`（当前数量）使用不一致 |
| 🟡 warning | `PLURAL_OFFSET_CONFLICT` | plural 的 `offset:` 不一致 |
| 🟡 warning | `TAG_MISSING` / `TAG_EXTRA` | 富文本标签不一致 |
| 🔵 info | `NON_STRING_VALUE` | 值不是字符串（数字/布尔/null/空容器），不参与 ICU 对比 |

> 复数类别缺失只记为警告：不同语言的 CLDR 类别集合本就不同（如中文通常只有 `other`）。真正的硬性契约是：**`other` 必须存在、占位符名称与类型一致、嵌套结构一致**。

---

## 📡 HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/projects` | 项目列表（含语言数、键数） |
| `POST` | `/api/projects` | 创建项目 `{ name, baseLocale? }` |
| `GET` | `/api/projects/:id` | 项目详情（语言、键、统计） |
| `PATCH` | `/api/projects/:id` | 修改名称 / 基准语言 |
| `DELETE` | `/api/projects/:id` | 删除项目（级联） |
| `POST` | `/api/projects/:id/locales` | 粘贴导入 `{ locale, content }`，导入后自动分析 |
| `POST` | `/api/projects/:id/locales/upload` | `multipart/form-data` 上传一个或多个 `files` |
| `DELETE` | `/api/projects/:id/locales/:code` | 删除某语言 |
| `GET` | `/api/projects/:id/messages?locale=&key=` | 查询消息原文与解析状态 |
| `POST` | `/api/projects/:id/analyze` | 重跑全量审查 `{ baseLocale? }` |
| `GET` | `/api/projects/:id/findings?severity=&locale=&search=` | 审查问题清单 |
| `POST` | `/api/projects/:id/preview` | 预览渲染 `{ locale, key, values }`（或 `{ inlineMessage, locale, values }`） |
| `GET` | `/api/projects/:id/report.json` | 导出 JSON 报告 |
| `GET` | `/api/projects/:id/report.csv` | 导出 CSV 报告 |

---

## 🧱 技术栈与目录结构

- **后端**：Node.js (ESM)、Express 4、`better-sqlite3`
- **ICU 引擎**：`@formatjs/icu-messageformat-parser`（AST 解析）、`intl-messageformat`（真实渲染，Node 20 内置 full-ICU）
- **前端**：原生 HTML / CSS / JavaScript，无构建步骤
- **存储**：单个 SQLite 文件，4 张表 `projects / locales / messages / findings`

```
locale-contract/
├── Dockerfile
├── docker-compose.yml
├── package.json
├── server/
│   ├── index.js      # Express 路由 / API / 静态托管
│   ├── db.js         # SQLite 初始化与表结构
│   ├── icu.js        # ICU AST 解析、模型构建、跨语言结构对比
│   ├── analyze.js    # JSON 扁平化、入库、全项目分析编排
│   ├── render.js     # 示例变量推断与 IntlMessageFormat 渲染
│   └── reports.js    # JSON / CSV 报告生成
├── public/
│   ├── index.html    # 单页界面
│   ├── styles.css
│   ├── app.js
│   └── samples/      # 内置示例目录（en / zh-CN / ja）
└── data/             # SQLite 数据库（运行时生成，已 gitignore）
```

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 监听端口 |
| `DATA_DIR` | `./data` | SQLite 数据库存放目录（容器内为 `/data`） |

---

## 📄 许可

MIT
