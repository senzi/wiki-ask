# Wiki Ask

**Ask your own knowledge base.** 一个搜索引擎式的问答 Web 应用：问题交给 Hermes Agent，它只读检索你维护的 markdown 知识库（LLM Wiki / Obsidian vault 均可），返回带引用、可溯源的答复卡片。

不是聊天机器人——是知识检索引擎：提问 → 看检索过程直播 → 得到带引用的答案卡片 → 本地归档随时回看。

## 工作原理

```
浏览器 ←──SSE── Flask ──spawn──> hermes chat -q "<问题>" -s <skill> --source wiki-ask
                  │
                  └── 轮询 Hermes 会话数据库（SQLite, WAL 只读）
                      按 session 增量读取 messages → 过程事件流
```

- **不改动 Hermes 源码**，通过 CLI + 会话数据库组合出完整的过程可见性
- 每次提问是独立进程、独立会话，天然支持并发与隔离
- 知识库只读，Agent 不会写入你的笔记

## 特性

- **过程直播**：思考块（可折叠）、工具卡片（文件名标签 / 失败红点）、逐步动画
- **引用可溯源**：答复中的引用渲染为卡片，点击新窗口打开笔记原文（markdown 渲染 + frontmatter 元信息面板）
- **本地档案**：问题、答复、完整过程日志存于浏览器 localStorage，回看零 API 消耗，可导出 JSON
- **搜索引擎式 UI**：单色科技风，大搜索框主页，不是聊天气泡

## 快速开始

### 1. 前置条件

- 安装并配置好 [Hermes Agent](https://github.com/NousResearch/hermes-agent)（模型 provider 可用）
- 一个 markdown 知识库目录（推荐按 [LLM Wiki 模式](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)维护，含 `index.md` 索引效果更佳）
- 安装问答 skill（决定答复模板与检索规范），参考 [docs/example-skill.md](docs/example-skill.md) 创建你自己的版本

### 2. 安装与配置

```powershell
git clone <this-repo> wiki-ask
cd wiki-ask
uv venv .venv; uv pip install --python .venv/Scripts/python.exe -r requirements.txt
# 或者：python -m venv .venv; .venv/Scripts/pip install -r requirements.txt

copy config.example.json config.json
# 编辑 config.json，填入你的 hermes 可执行文件路径、state.db 路径、知识库目录
```

`config.json` 字段说明：

| 字段 | 说明 |
|---|---|
| `hermes_exe` | Hermes CLI 可执行文件路径 |
| `state_db` | Hermes 会话数据库（state.db）路径 |
| `wiki_root` | 你的知识库根目录 |
| `skill` | 问答 skill 名称（需提前安装到 Hermes） |
| `source_tag` | 会话来源标记（用于在 DB 中匹配本次运行） |
| `timeout` | 单次提问超时秒数（默认 300） |
| `host` / `port` | Web 服务监听地址（默认 127.0.0.1:5007） |

### 3. 运行

```powershell
.\.venv\Scripts\python.exe app.py
# 打开 http://127.0.0.1:5007
```

## 目录结构

```
wiki-ask/
├── app.py               # Flask 入口：路由（ask/stream/wiki viewer/wiki 索引）
├── core.py              # 引擎：spawn Hermes CLI + state.db 轮询 → 事件流
├── config.example.json  # 配置模板（复制为 config.json 后填自己的路径）
├── requirements.txt
├── static/              # 前端（纯静态，无构建步骤）
│   ├── index.html       # 搜索引擎式主页/结果页
│   ├── app.js           # 前端逻辑（SSE、档案、展示推断）
│   ├── style.css        # 单色科技风样式
│   └── viewer.html      # wiki 原文查看器（拉取 /api/wiki-raw 渲染）
├── docs/                # 开发者文档
│   ├── events.md        # 事件流格式、state.db 字段、定制日志指南
│   └── example-skill.md # 通用问答 skill 模板
└── tests/               # 可公开测试（tests_private/ 已 gitignore，放私有数据）
```

## 文档

- [docs/events.md](docs/events.md) — 事件流格式、state.db 原始字段说明、过滤逻辑位置、如何获取更详细的日志
- [docs/example-skill.md](docs/example-skill.md) — 通用问答 skill 模板（答复模板 / 只读约束 / 引用格式）

## 测试

```powershell
.\.venv\Scripts\python.exe tests/test_engine.py   # 引擎冒烟测试（真实调用一次 LLM，约 1-3 分钟）
node tests/test_extraction.js                      # 展示层推断逻辑（离线，零成本）
```

`tests/` 是可公开的测试；`tests_private/` 已 gitignore，放本地私有测试数据（如导出的真实档案）。

## License

MIT
