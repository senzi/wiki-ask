# -*- coding: utf-8 -*-
"""引擎冒烟测试：不启动 Flask，直接测 core.start_ask 全流程。"""
import time

from core import start_ask


def main():
    q = "MD5 还安全吗？"
    print(f"[test] 提问: {q}")
    task = start_ask(q)
    print(f"[test] task_id={task.id}")

    offset = 0
    deadline = time.time() + 320
    while time.time() < deadline:
        events, offset, done = task.wait_events(offset, timeout=30)
        for ev in events:
            t = ev.get("type")
            if t == "answer":
                print(f"\n===== 最终答复（{len(ev['content'])} 字）=====")
                print(ev["content"][:600])
                print("...")
            else:
                print(f"  [{ev.get('ts'):>6}s] {t}: {ev.get('name') or ev.get('text') or ''} {ev.get('preview') or ''}")
        if done:
            break

    assert task.done, "任务未完成"
    assert task.answer, "没有拿到答复"
    assert "## 回答" in task.answer, "答复未遵循模板（缺少 ## 回答）"
    assert ".md" in task.answer, "答复未包含引用相对路径（.md）"
    assert task.session_id, "未捕获 session_id"
    n_reasoning = sum(1 for e in task.events if e["type"] == "reasoning")
    n_tools = sum(1 for e in task.events if e["type"] == "tool_call")
    print(f"\n[test] PASS · session={task.session_id} · elapsed={task.elapsed}s · reasoning={n_reasoning} · tool_calls={n_tools}")


if __name__ == "__main__":
    main()
