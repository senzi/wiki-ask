# AGENTS.md — 给 Agent 的迁移/部署指南

> 这份文档写给**帮助用户部署本项目的 AI Agent**（Hermes / Claude Code / Codex 等）。
> 目标：让用户 clone 之后，只改 `config.json` 一个文件就能跑起来。
> 请在动手前先读完本文，再按「确认 → 澄清 → 配置 → 验证 → 启动」的顺序执行。

## 项目一句话

Flask 后端 spawn `hermes chat -q ... -s <skill>` 子进程提问，轮询 Hermes 的 `state.db`（SQLite WAL）拿到过程事件，SSE 推给前端展示。知识库只读。

## 第一步：确认前置条件（自己先查，别问用户）

按顺序探测，能自动确认的不要打扰用户：

```bash
# 1. Hermes CLI 是否安装、路径是什么
which hermes || where hermes
hermes --version

# 2. state.db 在哪（通常在 Hermes home 下）
#    Windows: %LOCALAPPDATA%\hermes\state.db
#    Linux/macOS: ~/.hermes/state.db
#    也检查 $HERMES_HOME 环境变量

# 3. 问答 skill 是否已安装
hermes skills list | grep -i wiki
```

## 第二步：向用户澄清（必须问，不要猜）

以下信息**只有用户知道**，逐个问清楚：

1. **知识库根目录的绝对路径**（wiki_root）——这是必填项，没有默认值。
2. **问答 skill 是否已存在**：
   - 若第一步没找到 → 告诉用户需要安装一个，参考 `docs/example-skill.md`，把模板里的 `<你的知识库根目录>` 替换为上面的路径后安装（可以主动帮用户写 SKILL.md 到 Hermes skills 目录，写完让用户用 `hermes skills list` 确认）。
   - 若已存在但名字不同 → 把 `config.json` 的 `skill` 字段改成那个名字。
3. **是否需要自定义站点文案**（站名/副标题/页脚/预设问题）——不需要就用 `config.example.json` 里的通用默认值。
4. **端口**：默认 5007，问一句是否被占用/想改。

## 第三步：写配置

```bash
cp config.example.json config.json
```

填入：

| 字段 | 来源 |
|---|---|
| `hermes_exe` | 第一步 `which hermes` 的结果（Windows 注意是 `.exe` 全路径） |
| `state_db` | 第一步探测到的 state.db 路径 |
| `wiki_root` | 用户告知的知识库根目录 |
| `skill` | 已安装的问答 skill 名（默认 `llm-wiki-qa`） |
| `source_tag` | **不用改**（见下方说明） |
| `site` | 用户要自定义就改，否则保持默认 |

**关于 `source_tag`**：可以改，但没有必要。它只是写进 `sessions.source` 的一个标记字符串，方便在数据库里辨认"这些会话来自 wiki-ask"。后端的会话匹配**不依赖它**（用的是启动时间 + 首条 user 消息逐字匹配），所以改成任何字符串都不会影响功能。

## 第四步：验证（启动服务前）

```bash
# 安装依赖（项目用 uv；没有 uv 就 python -m venv）
uv venv .venv && uv pip install --python .venv/Scripts/python.exe -r requirements.txt

# 离线测试（零成本，秒级）
node tests/test_extraction.js        # 展示层推断逻辑，应全过

# 配置自检（不起服务器，用 Flask test_client）
.venv/Scripts/python.exe -c "
from app import app
c = app.test_client()
print('index:', c.get('/').status_code)          # 200
print('version:', c.get('/api/version').get_json())
print('wiki-index entries:', len(c.get('/api/wiki-index').get_json()))  # 应 > 0
"
```

`wiki-index entries` 为 0 → `wiki_root` 填错了，回去核对。

## 第五步：启动服务（先问用户）

**不要自作主张启动或重启用户的服务。** 先问：

> 配置和验证都通过了。要我现在帮你启动服务吗？还是你自己来？

- 用户说帮启动 →
  ```bash
  # Windows PowerShell 注意必须带 .\ 前缀
  .\.venv\Scripts\python.exe app.py
  ```
  启动后 `curl http://127.0.0.1:5007/api/version` 确认，再告诉用户打开浏览器访问。
- 用户自己来 → 给出上面的命令即可。

## 常见坑（提前告诉用户）

1. **改了 config.json 必须重启 Flask 才生效**。前端有版本检测，后端过旧会在页面顶部弹红色横幅提示重启。
2. **Windows PowerShell 启动命令要带 `.\` 前缀**（`.\.venv\Scripts\python.exe`），否则报 "not recognized"。
3. **Hermes 的 `search_files` 工具在部分 Windows 环境必败**（内部把路径转成 MSYS `/d/...` 形式，原生 rg 不认）。`docs/example-skill.md` 的模板已改用 terminal grep/find 规避——如果你自己改写了 skill，请保留这一点。
4. 真实提问一次约 60~120 秒（每次是一个完整 hermes 进程 + LLM 调用），这是"检索"不是"聊天"，提前管理用户预期。
5. 想验证全链路可以跑 `tests/test_engine.py`——**它会真实调用一次 LLM（花钱）**，跑之前先征得用户同意。
