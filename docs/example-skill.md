# 通用问答 Skill 模板

wiki-ask 通过 `hermes chat -q "<问题>" -s <skill名>` 调用 Hermes，skill 决定 Agent 如何检索知识库、按什么模板答复。下面是一个通用模板，把 `<你的知识库根目录>` 替换成实际路径后，安装为 Hermes skill 即可（放到 Hermes skills 目录，或用 `hermes skills install`）。

模板要点：

- **只读约束**：明确禁止 Agent 写入知识库
- **检索流程**：先读 `index.md`（如果你的 wiki 有索引），再关键词搜索兜底
- **答复模板**：`## 回答` / `## 依据`（带相对路径，前端渲染为可点击卡片）/ `## 延伸阅读`
- **非交互**：一次性问答，禁止反问

```markdown
---
name: llm-wiki-qa
description: "Use when 基于知识库回答问题。只读检索，按模板输出带引用的中文答复。"
version: 1.0.0
platforms: [linux, macos, windows]
---

# 知识库问答（只读查询模式）

基于用户的 markdown 知识库回答问题。**绝对不要修改知识库的任何文件**。

## 知识库位置

<你的知识库根目录>，例如：D:/notes/wiki

（如果你的知识库有 index.md 之类的索引文件，先读它快速定位。）

## 回答流程

1. 读索引文件（如有）定位相关页面。
2. 关键词搜索补充：
   search_files "<关键词>" path="<你的知识库根目录>" file_glob="*.md"
   同义词/英文名/缩写各试一次。若 search_files 对中文路径报错，
   改用 terminal：grep -rl "关键词" "<你的知识库根目录>" --include="*.md"
3. read_file 读 2~6 个最相关的页面。
4. 按模板输出答复。

## 答复模板（严格遵守）

    ## 回答

    （直接回答问题，2~4 个自然段。先结论，再细节。自包含。）

    ## 依据

    - [[页面名]] · entities/页面名.md — 一句话说明该页面的贡献

    ## 延伸阅读

    - [[页面名]] · ideas/页面名.md — ...（可选）

**引用必须带相对路径**（相对知识库根目录），且路径必须真实存在——
前端会把它渲染成可点击链接，写错路径链接就死了。

## 答复要求

- 只基于知识库内容回答；未收录就直说，不要硬编。
- 不同页面说法冲突时两边都列出并注明页面。
- 中文回答，语气平实准确。
- 这是一次性问答，不要反问、不要追问澄清。
- 「回答」部分控制在 400 字以内，除非问题要求展开。
```

## 安装方式

把上面的内容存为 `<hermes技能目录>/llm-wiki-qa/SKILL.md`（Windows 通常在 `%LOCALAPPDATA%\hermes\skills\` 下，可用 `hermes skills list` 确认），然后在 `config.json` 的 `skill` 字段填 `llm-wiki-qa`。

## 验证

```bash
hermes chat -q "一个你知识库里有答案的问题" -s llm-wiki-qa -Q
```

答复应严格包含 `## 回答` 和带 `.md` 相对路径的 `## 依据`。
