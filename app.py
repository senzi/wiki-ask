# -*- coding: utf-8 -*-
"""wiki-ask Flask 入口：搜索引擎式 LLM Wiki 问答。"""
import json
import os
import time
import unicodedata

from flask import Flask, jsonify, request, Response, send_from_directory, abort

from core import start_ask, get_task, CONFIG

WIKI_ROOT = CONFIG["wiki_root"]
APP_VERSION = "2026-07-27.1"  # 前端用它检测后端是否过旧（改了记得 bump）

app = Flask(__name__, static_folder="static", static_url_path="")


def _safe_wiki_path(relpath: str):
    """把相对路径解析到 WIKI_ROOT 下，拒绝穿越。NFC/NFD 归一化兜底。"""
    import os
    import unicodedata
    root = os.path.realpath(WIKI_ROOT)
    for candidate in {relpath, unicodedata.normalize("NFC", relpath), unicodedata.normalize("NFD", relpath)}:
        full = os.path.realpath(os.path.join(WIKI_ROOT, candidate))
        if not full.lower().startswith(root.lower() + os.sep):
            continue
        if os.path.isfile(full) and full.lower().endswith(".md"):
            return full
    return None


@app.route("/wiki/<path:relpath>")
def wiki_file(relpath):
    """校验路径后返回统一的查看器页面（static/viewer.html 再拉取 /api/wiki-raw）。"""
    if _safe_wiki_path(relpath) is None:
        abort(404)
    return send_from_directory("static", "viewer.html")


@app.route("/api/wiki-raw/<path:relpath>")
def wiki_raw(relpath):
    """返回 wiki 页面的原始 markdown（JSON）。"""
    full = _safe_wiki_path(relpath)
    if full is None:
        abort(404)
    with open(full, "r", encoding="utf-8") as f:
        return jsonify({"relpath": relpath, "raw": f.read()})


@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/api/version")
def version():
    return jsonify({"version": APP_VERSION})


@app.route("/api/wiki-index")
def wiki_index():
    """文件名（不含 .md）→ 相对路径 的索引，供前端把 [[wikilink]] 解析成链接。
    60 秒 TTL 缓存。同名页面先扫到的优先。"""
    now = time.time()
    if now - _wiki_index_cache["ts"] > 60:
        mapping = {}
        for root, _dirs, files in os.walk(WIKI_ROOT):
            for fn in files:
                if fn.lower().endswith(".md"):
                    rel = os.path.relpath(os.path.join(root, fn), WIKI_ROOT).replace("\\", "/")
                    # 统一 NFC 归一化，避免 LLM 输出与磁盘文件名形态不一致（å 等字符）
                    mapping.setdefault(unicodedata.normalize("NFC", fn[:-3]), rel)
        _wiki_index_cache.update(ts=now, map=mapping)
    return jsonify(_wiki_index_cache["map"])


_wiki_index_cache = {"ts": 0.0, "map": {}}


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
