# -*- coding: utf-8 -*-
"""
wiki-ask 核心引擎：通过 Hermes CLI 子进程提问，轮询 state.db 获取过程事件。

方案 B 架构：
  用户问题 -> hermes chat -q ... -s llm-wiki-qa 子进程
           -> state.db (SQLite WAL) 轮询 messages 表
           -> 事件流 (tool 调用 / 工具结果 / 最终答复)
"""
import json
import os
import re
import sqlite3
import subprocess
import threading
import time
import uuid

_CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")


def _load_config() -> dict:
    if not os.path.exists(_CONFIG_PATH):
        raise SystemExit(
            "缺少 config.json —— 请复制 config.example.json 为 config.json，"
            "并填入你自己的 Hermes / state.db / Wiki 路径。"
        )
    with open(_CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


CONFIG = _load_config()
HERMES_EXE = CONFIG["hermes_exe"]
STATE_DB = CONFIG["state_db"]
SKILL = CONFIG.get("skill", "llm-wiki-qa")
SOURCE_TAG = CONFIG.get("source_tag", "wiki-ask")
WORKDIR = CONFIG.get("workdir") or os.path.dirname(os.path.abspath(__file__))
TIMEOUT = int(CONFIG.get("timeout", 300))  # 秒

_tasks = {}
_lock = threading.Lock()
_claimed_sessions = set()  # 已被某个任务认领的 session_id（防并发撞车）


def _site_text(key: str, default: str) -> str:
    """站点文案（后端侧状态提示），来自 config.json 的 site 段。"""
    return str(CONFIG.get("site", {}).get(key) or default)


class AskTask:
    def __init__(self, question: str):
        self.id = uuid.uuid4().hex[:12]
        self.question = question
        self.created_at = time.time()
        self.events = []          # 已产生的事件列表（供 SSE 重放）
        self.done = False
        self.error = None
        self.answer = None
        self.session_id = None
        self.elapsed = None
        self._cond = threading.Condition()

    def emit(self, event: dict):
        event["ts"] = round(time.time() - self.created_at, 1)
        with self._cond:
            self.events.append(event)
            self._cond.notify_all()

    def wait_events(self, offset: int, timeout: float = 30.0):
        """从 offset 开始等待新事件，返回 (events, new_offset, done)。"""
        with self._cond:
            if len(self.events) <= offset and not self.done:
                self._cond.wait(timeout)
            return list(self.events[offset:]), len(self.events), self.done


def _db():
    return sqlite3.connect(f"file:{STATE_DB}?mode=ro", uri=True, timeout=5)


def _claim_session_id(launch_ts: float, prompt: str):
    """在 state.db 中找本次运行对应的 session 并原子认领。

    匹配条件：启动时间 + 首条 user 消息 == 完整 prompt。
    认领是原子操作（同一把锁里 check-and-add）：两个相同问题并发时，
    各自认领不同的 session，不会认领同一个。
    """
    try:
        db = _db()
        rows = db.execute(
            "SELECT id FROM sessions WHERE started_at >= ? ORDER BY started_at ASC",
            (launch_ts - 5,),
        ).fetchall()
        candidates = []
        for (sid,) in rows:
            msg = db.execute(
                "SELECT content FROM messages WHERE session_id=? AND role='user' ORDER BY id LIMIT 1",
                (sid,),
            ).fetchone()
            if msg and (msg[0] or "").strip() == prompt.strip():
                candidates.append(sid)
        db.close()
    except sqlite3.Error:
        return None
    with _lock:
        for sid in candidates:
            if sid not in _claimed_sessions:
                _claimed_sessions.add(sid)
                return sid
    return None


def _run_task(task: AskTask):
    launch_ts = time.time()
    # 完整提示词模板：{question} 为用户原始问题
    prompt = f"使用 {SKILL} skill，回答用户的问题：{task.question}"
    cmd = [
        HERMES_EXE, "chat",
        "-q", prompt,
        "-s", SKILL,
        "--source", SOURCE_TAG,
        "-Q",
    ]
    task.emit({"type": "status", "text": _site_text("status_waking", "正在唤醒 Agent…")})
    # stderr 写入临时文件（而非丢弃）：进程异常退出时可用于诊断
    import tempfile
    stderr_tmp = tempfile.TemporaryFile(mode="w+b")
    try:
        proc = subprocess.Popen(
            cmd, cwd=WORKDIR,
            stdout=subprocess.DEVNULL, stderr=stderr_tmp,
        )
    except OSError as e:
        task.emit({"type": "error", "text": f"无法启动 hermes: {e}"})
        task.done = True
        with task._cond:
            task._cond.notify_all()
        return

    last_msg_id = 0
    saw_tool = False
    deadline = time.time() + TIMEOUT

    while True:
        # 超时保护
        if time.time() > deadline:
            proc.kill()
            task.emit({"type": "error", "text": f"超时（{TIMEOUT}s），已终止"})
            break

        # 找 session（注意：匹配的是包装后的完整 prompt，不是裸问题）
        if task.session_id is None:
            sid = _claim_session_id(launch_ts, prompt)
            if sid:
                task.session_id = sid
                task.emit({"type": "status", "text": _site_text("status_connected", "已接入知识库，开始检索…"), "session_id": sid})

        # 增量读消息
        if task.session_id:
            try:
                db = _db()
                rows = db.execute(
                    "SELECT id, role, tool_name, content, tool_calls, reasoning_content "
                    "FROM messages "
                    "WHERE session_id=? AND id>? ORDER BY id",
                    (task.session_id, last_msg_id),
                ).fetchall()
                db.close()
                for mid, role, tool_name, content, tool_calls, reasoning in rows:
                    last_msg_id = mid
                    if role == "assistant" and reasoning and reasoning.strip():
                        task.emit({"type": "reasoning", "text": reasoning.strip()})
                    if role == "assistant" and tool_calls:
                        try:
                            calls = json.loads(tool_calls)
                        except (ValueError, TypeError):
                            calls = []
                        for c in calls:
                            name = c.get("name") or c.get("function", {}).get("name") or "tool"
                            args = c.get("arguments") or c.get("function", {}).get("arguments") or ""
                            if isinstance(args, dict):
                                args = json.dumps(args, ensure_ascii=False)
                            # 存完整原始参数（日志用于调试/事后分析，
                            # 展示层的提取在前端做，见 app.js extractTarget）
                            task.emit({"type": "tool_call", "name": name,
                                       "args": str(args)[:20000]})
                            saw_tool = True
                    elif role == "tool":
                        # 存完整原始返回（上限 50k 字符保护存储）
                        task.emit({"type": "tool_result", "name": tool_name or "tool",
                                   "raw": (content or "")[:50000]})
                    elif role == "assistant" and content:
                        # 中途的 assistant 文本（最终答复以进程退出后最后一次为准）
                        task.answer = content
            except sqlite3.Error as e:
                # 不再静默：把 DB 异常暴露到事件流（限一次，避免刷屏）
                if not getattr(task, "_db_err_noted", False):
                    task._db_err_noted = True
                    task.emit({"type": "status", "text": f"state.db 读取异常（自动重试中）：{e}"})

        if proc.poll() is not None:
            break
        time.sleep(1.2)

    # 收尾：最后再从 DB 抓一次，防止遗漏尾部消息
    time.sleep(0.5)
    if task.session_id:
        try:
            db = _db()
            rows = db.execute(
                "SELECT content FROM messages WHERE session_id=? AND role='assistant' "
                "AND content IS NOT NULL AND content!='' ORDER BY id DESC LIMIT 1",
                (task.session_id,),
            ).fetchone()
            db.close()
            if rows and rows[0]:
                task.answer = rows[0]
        except sqlite3.Error:
            pass

    task.elapsed = round(time.time() - launch_ts, 1)
    rc = proc.poll()

    def _stderr_tail(n: int = 500) -> str:
        try:
            stderr_tmp.seek(0, 2)
            size = stderr_tmp.tell()
            stderr_tmp.seek(max(0, size - n))
            return stderr_tmp.read().decode("utf-8", "replace").strip()
        except (OSError, ValueError):
            return ""

    if task.answer:
        task.emit({"type": "answer", "content": task.answer})
        task.emit({"type": "done", "elapsed": task.elapsed, "session_id": task.session_id})
    elif rc not in (0, None):
        tail = _stderr_tail()
        msg = f"hermes 进程异常退出（code {rc}）"
        if tail:
            msg += f"\nstderr: {tail}"
        task.emit({"type": "error", "text": msg})
    elif not any(e["type"] == "error" for e in task.events):
        task.emit({"type": "error", "text": "没有拿到答复，请重试"})
    stderr_tmp.close()

    task.done = True
    with task._cond:
        task._cond.notify_all()


def start_ask(question: str) -> AskTask:
    task = AskTask(question)
    with _lock:
        _tasks[task.id] = task
        # 简单清理：保留最近 50 个任务
        if len(_tasks) > 50:
            for k in sorted(_tasks, key=lambda x: _tasks[x].created_at)[:-50]:
                _tasks.pop(k, None)
    threading.Thread(target=_run_task, args=(task,), daemon=True).start()
    return task


def get_task(task_id: str):
    with _lock:
        return _tasks.get(task_id)
