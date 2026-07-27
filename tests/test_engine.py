# -*- coding: utf-8 -*-
"""引擎冒烟测试：不启动 Flask，直接测 core.start_ask 全流程。

⚠️ 会真实调用一次 LLM（产生费用），跑之前想清楚。
测试问题可用环境变量覆盖（适配任意知识库）：
    WIKI_ASK_TEST_QUESTION="你的知识库里有的问题" python tests/test_engine.py
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core import start_ask

TEST_QUESTION = os.environ.get("WIKI_ASK_TEST_QUESTION", "这个知识库覆盖了哪些主题？")


def main():
    q = TEST_QUESTION
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
