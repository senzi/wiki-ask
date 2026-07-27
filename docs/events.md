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
2. 该会话第一条 `role='user'` 消息的 `content` 与问题**逐字相等**

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
| `tool_call` | `name`, `label`, `preview` | 工具调用。`label` 是友好标签，`preview` 是截断的原始参数 |
| `tool_result` | `name`, `ok`, `preview` | 工具结果。`ok=false` 表示失败 |
| `answer` | `content` | 最终答复全文（未截断） |
| `done` | `elapsed`, `session_id` | 完成 |
| `error` | `text` | 致命错误 |

## 过滤/加工逻辑的位置（想改就改这里）

全部在 `core.py`：

| 函数 | 做了什么 | 想要更详细日志？ |
|---|---|---|
| `_preview(text, n)` | 压缩空白 + 截断到 n 字符 | 调大 n 或直接返回原文 |
| `_tool_label(name, args)` | 从参数提取友好标签：read_file→文件名、terminal→命令头（60 字符）、search_files→pattern | 把 `preview` 从 100 字符改成完整 `args`，前端即可显示完整参数 |
| `_result_ok(content)` | `error` 非空或 `exit_code≠0` → 失败 | — |
| `_result_preview(content)` | 结果摘要：read_file→"N 行"、terminal→输出（120 字符）、search_files→"N 个结果" | 在 emit 里加 `"raw": content` 字段，前端即可拿到完整 JSON |

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
