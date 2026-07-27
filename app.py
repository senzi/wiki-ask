# -*- coding: utf-8 -*-
"""wiki-ask Flask 入口：搜索引擎式 LLM Wiki 问答。"""
import json
import queue

from flask import Flask, jsonify, request, Response, send_from_directory, abort

from core import start_ask, get_task, CONFIG

WIKI_ROOT = CONFIG["wiki_root"]

app = Flask(__name__, static_folder="static", static_url_path="")

VIEWER_HTML = r"""<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>__TITLE__ · Wiki</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23060606'/%3E%3Cpath d='M32 9 L55 32 L32 55 L9 32 Z' fill='none' stroke='%23e8e8e8' stroke-width='3'/%3E%3Ccircle cx='32' cy='32' r='5' fill='%23e8e8e8'/%3E%3C/svg%3E">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/lxgw-wenkai-webfont@1.7.0/style.css">
<script src="https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js"></script>
<style>
body{background:#0a0a0a;color:#e5e5e5;font-family:"LXGW WenKai",serif;margin:0;padding:48px 20px;}
main{max-width:760px;margin:0 auto;}
.crumbs{font-family:Consolas,monospace;font-size:12.5px;color:#666;letter-spacing:.08em;
  border-bottom:1px solid #222;padding-bottom:14px;margin-bottom:30px;}
/* frontmatter 元信息面板 */
.meta-panel{border:1px solid #222;border-radius:14px;background:#0f0f10;padding:20px 24px;margin-bottom:34px;}
.meta-title{font-size:26px;font-weight:700;color:#fff;line-height:1.4;}
.meta-rows{display:flex;flex-wrap:wrap;gap:8px 22px;margin-top:12px;
  font-family:Consolas,monospace;font-size:12px;color:#888;}
.meta-rows b{color:#555;font-weight:400;margin-right:6px;}
.meta-tags{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px;}
.meta-tag{font-family:Consolas,monospace;font-size:11.5px;color:#bbb;
  border:1px solid #2c2c2c;border-radius:6px;padding:3px 10px;background:#141414;}
.meta-sources{margin-top:12px;font-family:Consolas,monospace;font-size:11.5px;color:#666;line-height:1.8;word-break:break-all;}
.meta-sources b{color:#555;font-weight:400;}
.markdown{font-size:16.5px;line-height:1.95;}
.markdown h1,.markdown h2,.markdown h3{color:#fff;margin:26px 0 12px;}
.markdown h1{font-size:26px;}.markdown h2{font-size:20px;border-left:3px solid #fff;padding-left:12px;}
.markdown p{margin:12px 0;}.markdown ul,.markdown ol{padding-left:24px;margin:10px 0;}
.markdown li{margin:6px 0;}
.markdown a{color:#ccc;text-decoration:underline;text-underline-offset:3px;}
.markdown code{background:#1a1a1a;padding:2px 7px;border-radius:5px;font-size:.9em;
  font-family:Consolas,monospace;}
.markdown pre{background:#111;border:1px solid #222;border-radius:10px;padding:16px;overflow-x:auto;}
.markdown pre code{background:none;padding:0;}
.markdown blockquote{border-left:3px solid #444;margin:14px 0;padding:4px 16px;color:#999;}
.markdown table{border-collapse:collapse;margin:14px 0;width:100%;}
.markdown th,.markdown td{border:1px solid #2a2a2a;padding:8px 12px;font-size:14.5px;}
.markdown th{background:#141414;color:#fff;}
.markdown img{max-width:100%;}
</style></head><body><main>
<div class="crumbs">◈ LLM WIKI / __PATH__</div>
<div id="metaHost"></div>
<div id="content" class="markdown"></div>
</main>
<script id="raw" type="text/plain">__RAW__</script>
<script>
let raw = document.getElementById('raw').textContent;

// 剥离 YAML frontmatter，渲染为元信息面板
const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
if (fm) {
  const meta = {};
  for (const line of fm[1].split(/\r?\n/)) {
    const m = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (m) meta[m[1]] = m[2].trim();
  }
  raw = raw.slice(fm[0].length);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const list = (v) => (v || '').replace(/^\[|\]$/g, '').split(',').map((x) => x.trim()).filter(Boolean);
  let html = '<div class="meta-panel">';
  if (meta.title) html += `<div class="meta-title">${esc(meta.title)}</div>`;
  html += '<div class="meta-rows">';
  if (meta.type) html += `<span><b>TYPE</b>${esc(meta.type)}</span>`;
  if (meta.created) html += `<span><b>CREATED</b>${esc(meta.created)}</span>`;
  if (meta.updated) html += `<span><b>UPDATED</b>${esc(meta.updated)}</span>`;
  if (meta.confidence) html += `<span><b>CONF</b>${esc(meta.confidence)}</span>`;
  if (meta.status) html += `<span><b>STATUS</b>${esc(meta.status)}</span>`;
  html += '</div>';
  const tags = list(meta.tags);
  if (tags.length) html += `<div class="meta-tags">${tags.map((t) => `<span class="meta-tag">#${esc(t)}</span>`).join('')}</div>`;
  const srcs = list(meta.sources);
  if (srcs.length) html += `<div class="meta-sources"><b>SOURCES</b>${srcs.map(esc).join('<br>')}</div>`;
  html += '</div>';
  document.getElementById('metaHost').innerHTML = html;
}

document.getElementById('content').innerHTML = DOMPurify.sanitize(marked.parse(raw));
</script></body></html>"""


def _safe_wiki_path(relpath: str):
    """把相对路径解析到 WIKI_ROOT 下，拒绝穿越。"""
    import os
    full = os.path.realpath(os.path.join(WIKI_ROOT, relpath))
    root = os.path.realpath(WIKI_ROOT)
    if not full.lower().startswith(root.lower() + os.sep):
        return None
    if not os.path.isfile(full) or not full.lower().endswith(".md"):
        return None
    return full


@app.route("/wiki/<path:relpath>")
def wiki_file(relpath):
    full = _safe_wiki_path(relpath)
    if full is None:
        abort(404)
    with open(full, "r", encoding="utf-8") as f:
        raw = f.read()
    # 防止原始内容里出现 </script> 闭合掉容器
    raw_safe = raw.replace("</script>", "<\\/script>")
    title = relpath.rsplit("/", 1)[-1].replace(".md", "")
    html = (VIEWER_HTML
            .replace("__RAW__", raw_safe)
            .replace("__TITLE__", title)
            .replace("__PATH__", relpath))
    return Response(html, mimetype="text/html")



@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/api/ask", methods=["POST"])
def ask():
    data = request.get_json(force=True, silent=True) or {}
    question = (data.get("question") or "").strip()
    if not question:
        return jsonify({"error": "question 不能为空"}), 400
    if len(question) > 500:
        return jsonify({"error": "问题太长了（>500 字）"}), 400
    task = start_ask(question)
    return jsonify({"task_id": task.id, "question": task.question})


@app.route("/api/stream/<task_id>")
def stream(task_id):
    task = get_task(task_id)
    if task is None:
        return jsonify({"error": "task not found"}), 404

    def gen():
        offset = 0
        while True:
            events, offset, done = task.wait_events(offset, timeout=25.0)
            if not events and not done:
                # 心跳，防代理断连
                yield ": ping\n\n"
                continue
            for ev in events:
                yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
            if done:
                yield "event: close\ndata: {}\n\n"
                break

    return Response(
        gen(),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


if __name__ == "__main__":
    app.run(
        host=CONFIG.get("host", "127.0.0.1"),
        port=int(CONFIG.get("port", 5007)),
        debug=False,
        threaded=True,
    )
