# 事件流与日志格式

本文档说明 wiki-ask 的过程事件从哪来、原始数据长什么样、在哪里做了过滤/截断，以及如何修改以获得更详细的日志。目标读者：想定制过程展示的开发者。

## 数据来源：Hermes 会话数据库

Hermes Agent 把每个会话实时写入 `state.db`（SQLite，WAL 模式）。WAL 意味着**写入进行中可以并发只读**，这是整个方案的基础。

连接方式（`core.py:_db`）：

```python
sqlite3.connect(f"file:{STATE_DB}?mode=ro", uri=True, timeout=5)
```

### 相关表结构

**`sessions`**（每次运行一行）

| 列 | 含义 |
|---|---|
| `id` | 会话 ID，格式 `YYYYMMDD_HHMMSS_xxxxxx` |
| `source` | 来源标记。CLI 可用 `--source` 指定，本应用用它辅助匹配 |
| `started_at` | Unix 时间戳（秒，浮点） |
| `system_prompt` | 完整系统提示词（可用来验证 skill 是否注入） |

**`messages`**（会话内的每条消息一行，按 `id` 自增即时间序）

| 列 | 含义 |
|---|---|
| `id` | 全局自增主键 |
| `session_id` | 所属会话 |
| `role` | `user` / `assistant` / `tool` |
| `content` | 文本内容（见下文，按 role 含义不同） |
| `tool_calls` | assistant 消息的工具调用，JSON 数组**字符串** |
| `tool_name` | tool 消息对应的工具名 |
| `reasoning_content` | assistant 消息的推理/思考文本 |
| `timestamp` | Unix 时间戳 |

### 会话匹配策略（`core.py:_find_session_id`）

子进程启动后，用两个条件在 `sessions` 里找本次运行：

1. `started_at >= 启动时间 - 5s`
2. 该会话第一条 `role='user'` 消息的 `content` 与**完整 prompt 逐字相等**

注意 CLI 收到的是包装后的完整提示词（`core.py:_run_task`）：

```
使用 {skill} skill，回答用户的问题：{question}
```

比解析 stdout 里的 `session_id:` 行更可靠（输出格式随 quiet/verbose 变化）。

## 各类消息的 raw 格式

### `user`

`content` 就是问题原文。

### `assistant`（发起工具调用）

`content` 通常为空；`tool_calls` 是 JSON 数组字符串：

```json
[
  {
    "id": "read_file_0",
    "call_id": "read_file_0",
    "response_item_id": "fc_read_file_...",
    "name": "read_file",
    "arguments": "{\"path\": \"D:/wiki/entities/MD5.md\"}"
  }
]
```

注意：

- `arguments` 可能是 **JSON 字符串**，也可能直接是 **dict**（取决于 provider 的序列化方式）。`core.py` 两种都兼容。
- 一条 assistant 消息可携带**多个**工具调用（并行调用）。前端用 FIFO 队列把后续的 tool 消息逐一配对这些卡片。

### `tool`（工具返回）

`tool_name` + `content`（JSON 字符串）。不同工具的结构：

**read_file**

```json
{"content": "1|# 第一行\n2|第二行\n...", "total_lines": 182}
```

`content` 带行号前缀（`行号|内容`）。

**search_files**

```json
{"matches": [...], "total_count": 5, "error": null}
```

失败时 `error` 为非空字符串（如 `Search failed: rg: ...`）。

**terminal**

```json
{"output": "stdout 文本", "exit_code": 0, "error": null}
```

非零 `exit_code` 或 `error` 非空即失败。

**skill_view / 其他工具**

结构各异，共同点是：dict 且含非空 `error` 字段时视为失败。

### `assistant`（思考）

`reasoning_content` 为推理文本（纯文本，可能多段）。一条 assistant 消息可以**同时**有 `reasoning_content` 和 `tool_calls`——先思考、再调用。

### `assistant`（最终答复）

进程退出前最后一条 `content` 非空的 assistant 消息即最终答复。本应用在进程退出后再补抓一次（`ORDER BY id DESC LIMIT 1`），防止轮询间隙丢尾部消息。

## 事件流格式（SSE → 前端）

后端 `POST /api/ask` 创建任务，`GET /api/stream/<task_id>` 以 SSE 推送。每个事件带 `ts`（相对秒数）：

| `type` | 字段 | 说明 |
|---|---|---|
| `status` | `text` | 状态提示（"正在唤醒…"等） |
| `reasoning` | `text` | 思考原文（**未截断**） |
| `tool_call` | `name`, `args` | 工具调用。**`args` 是完整原始参数 JSON**（20k 字符上限） |
| `tool_result` | `name`, `raw` | 工具结果。**`raw` 是完整原始返回 JSON**（50k 字符上限） |
| `answer` | `content` | 最终答复全文（未截断） |
| `done` | `elapsed`, `session_id` | 完成 |
| `error` | `text` | 致命错误 |

**设计原则：日志存 raw，展示靠推断。** 后端不做任何"友好化"加工——导出的 JSON 档案用于调试和事后分析，越完整越好；前端（`static/app.js`）负责从 raw 推断显示内容：

| 前端函数 | 推断逻辑 |
|---|---|
| `extractTarget(ev)` | 从 `args` 提取展示目标：read_file→文件 basename、search_files→pattern、terminal→命令头（60 字符）。JSON.parse 失败时正则兜底，再失败退化为"某个文件/某个关键词" |
| `detectOk(ev)` | 从 `raw` 判定成败：`error` 非空或 `exit_code≠0` → 失败（红点 + 显示错误原因） |
| `failureText(ev)` | 失败时从 `raw` 提取 `error` 字段文本 |

历史格式兼容：过渡版的 `label`/`ok` 字段、旧档案的截断 `preview` 字段，三个函数都能识别。

## Wikilink 解析（`/api/wiki-index`）

答复正文中的 `[[wikilink]]` 由前端渲染为超链接：

1. 前端启动时拉取 `GET /api/wiki-index` —— 后端扫描 `wiki_root` 下所有 `.md`，返回 `{文件名(不含.md): 相对路径}`（60 秒 TTL 缓存，同名先扫到优先）
2. `linkifyWikilinks()` 把命中索引的 `[[页面]]` 渲染为 `<a class="wl" href="/wiki/<相对路径>">`，未命中的渲染为 `.wl-dead` 死链样式
3. `/wiki/<path>` 路由有路径穿越防护（`app.py:_safe_wiki_path`）

## 过滤/加工逻辑的位置（想改就改这里）

后端（`core.py`）现在只做两件事：轮询 + 透传。所有展示层的"友好化"都在前端 `static/app.js`：

| 位置 | 做了什么 | 想要更详细日志？ |
|---|---|---|
| `core.py` tool_call emit | `args` 截断到 20k 字符 | 调大或去掉上限 |
| `core.py` tool_result emit | `raw` 截断到 50k 字符 | 调大或去掉上限（注意 localStorage 配额） |
| `app.js extractTarget` | 决定工具卡片显示什么 | 想显示完整参数 → 直接返回 `ev.args` |
| `app.js saveHistory` | 单条 events 上限 300 条、历史 100 条 | 调大（注意 5~10MB localStorage 配额） |

其他可调点：

- **轮询间隔**：`_run_task` 里的 `time.sleep(1.2)`——调小更实时，注意 DB 读压力
- **超时**：`config.json` 的 `timeout`（默认 300s）
- **前端归档上限**：`static/app.js` 的 `saveHistory` 中 `events.slice(0, 300)` 和历史条数 100
- **思考块**：reasoning 事件目前是整段到达（Hermes 落盘粒度），不是逐 token；如需逐 token 流，应走 Hermes API Server 的 `/v1/runs/{id}/events`（`message.delta`），属于另一条技术路线

## 调试技巧

直接用 SQL 观察一次运行的原始数据：

```bash
sqlite3 state.db "SELECT id, role, tool_name, substr(content,1,80) FROM messages WHERE session_id='<sid>' ORDER BY id"
```

或验证 skill 是否注入：

```bash
sqlite3 state.db "SELECT system_prompt LIKE '%<skill-name>%' FROM sessions WHERE id='<sid>'"
```
