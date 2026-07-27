/* 析问 · Wiki Ask 前端逻辑 — Hermes 桌面端风格过程展示 */
const $ = (s) => document.querySelector(s);

const LS_KEY = "wiki-ask-history-v2";

/* ---------- 历史记录（localStorage，含过程日志） ---------- */
function loadHistory() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; }
  catch { return []; }
}
function saveHistory(list) {
  // 过程日志可能很大，单条 events 截断保护
  const trimmed = list.slice(0, 100).map((x) => ({
    ...x, events: (x.events || []).slice(0, 300),
  }));
  try { localStorage.setItem(LS_KEY, JSON.stringify(trimmed)); }
  catch { // 超出配额时逐步丢弃最旧记录
    trimmed.pop(); saveHistory(trimmed);
  }
}
function addHistory(item) {
  const list = loadHistory();
  list.unshift(item);
  saveHistory(list);
  renderHistory();
}
function delHistory(id) {
  saveHistory(loadHistory().filter((x) => x.id !== id));
  renderHistory();
}

function renderHistory() {
  const list = loadHistory();
  const box = $("#historyList");
  if (!list.length) {
    box.innerHTML = `<div class="hist-empty">档案室空空如也<br>去问点什么吧 ◈</div>`;
    return;
  }
  box.innerHTML = "";
  for (const item of list) {
    const div = document.createElement("div");
    div.className = "hist-item";
    const d = new Date(item.time);
    // 步数与时间线实际渲染的元素对齐：tool_result 并入工具卡片、answer 不在时间线
    const steps = (item.events || []).filter((e) => e.type !== "answer" && e.type !== "tool_result").length;
    div.innerHTML = `
      <div class="hist-q"></div>
      <div class="hist-t">${d.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} · ${item.elapsed ?? "?"}s · ${steps} 步</div>
      <button class="hist-del" title="删除">✕</button>`;
    div.querySelector(".hist-q").textContent = item.question;
    div.querySelector(".hist-del").onclick = (e) => { e.stopPropagation(); delHistory(item.id); };
    div.onclick = () => { closeDrawer(); showResult(item); };
    box.appendChild(div);
  }
}

/* ---------- 视图切换 ---------- */
function toLanding() {
  $("#results").classList.add("hidden");
  $("#landing").classList.remove("hidden");
  $("#mainInput").focus();
}
function toResults(question) {
  $("#landing").classList.add("hidden");
  $("#results").classList.remove("hidden");
  $("#qTitle").textContent = question;
  $("#topInput").value = question;
  $("#timeline").innerHTML = "";
  $("#citations").classList.add("hidden");
  $("#metaLine").classList.add("hidden");
  $("#answerBody").innerHTML = `
    <div class="thinking">
      <span class="dot"></span><span class="dot"></span><span class="dot"></span>
      <span class="thinking-text">析染正在翻阅 Wiki…</span>
    </div>`;
  _pendingTools = [];
}

/* ---------- 过程时间线（桌面端风格） ---------- */
const TOOL_LABEL = {
  search_files: "search_files / 搜索",
  read_file: "read_file / 阅读",
  terminal: "terminal / 终端",
  skill_view: "skill_view / 技能",
};
let _pendingTools = [];  // 待配对结果的工具卡片（FIFO）

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------- 展示推断：从完整 raw 日志提取显示信息 ----------
   日志存的是原始 args/raw（调试友好），展示层在这里推断。
   兼容三代格式：args/raw（当前）> label/ok（过渡版）> preview（旧档案）。 */

function _tryParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function extractTarget(ev) {
  if (ev.label) return ev.label;  // 过渡版兼容
  const name = ev.name;
  const s = ev.args || ev.preview || "";
  const a = _tryParse(s);
  if (a && typeof a === "object") {
    if (name === "read_file" && a.path) {
      return String(a.path).replace(/\\/g, "/").split("/").pop() || "某个文件";
    }
    if (name === "search_files") return a.pattern || a.file_glob || "某个关键词";
    if (name === "terminal" && a.command) return String(a.command).slice(0, 60);
    if (name === "skill_view") return a.name || "";
  }
  // 旧档案 preview 可能被截断，正则兜底
  if (name === "read_file") {
    const m = s.match(/"path"\s*:\s*"([^"]+)"/);
    if (m) {
      const base = m[1].replace(/\\\\/g, "/").replace(/\\/g, "/").split("/").pop();
      if (base && !base.startsWith("{")) return base;
    }
    const m2 = s.match(/([\w\u4e00-\u9fff（）()\-]+\.\w{1,5})/);
    return m2 ? m2[1] : "某个文件";
  }
  if (name === "search_files") {
    const m = s.match(/"pattern"\s*:\s*"([^"]+)"/) || s.match(/"file_glob"\s*:\s*"([^"]+)"/);
    return m ? m[1] : "某个关键词";
  }
  if (name === "terminal") {
    const m = s.match(/"command"\s*:\s*"([^"]{1,60})/);
    return m ? m[1] : "某条命令";
  }
  return "";
}

function detectOk(ev) {
  if (ev.ok !== undefined) return ev.ok;  // 过渡版兼容
  const s = ev.raw || ev.preview || "";
  const d = _tryParse(s);
  if (d && typeof d === "object") {
    if (d.error) return false;
    if (d.exit_code !== undefined && d.exit_code !== null && d.exit_code !== 0) return false;
    return true;
  }
  if (/"error"\s*:\s*"[^"]/.test(s)) return false;
  if (/"exit_code"\s*:\s*[1-9]/.test(s)) return false;
  return true;
}

function failureText(ev) {
  const s = ev.raw || ev.preview || "";
  const d = _tryParse(s);
  if (d && typeof d === "object" && d.error) return String(d.error);
  const m = s.match(/"error"\s*:\s*"([^"]+)"/);
  return m ? m[1] : s.slice(0, 200);
}

function tlStatus(text, cls = "") {
  const div = document.createElement("div");
  div.className = `tl-status ${cls}`;
  div.textContent = text;
  $("#timeline").appendChild(div);
  scrollProc();
}

function tlReasoning(text) {
  const det = document.createElement("details");
  det.className = "think";
  det.innerHTML = `<summary>THINKING / 思考</summary><div class="think-body">${escapeHtml(text)}</div>`;
  $("#timeline").appendChild(det);
  _pendingTools = [];
  scrollProc();
}

function tlToolCall(ev) {
  const card = document.createElement("div");
  card.className = "tool-card";
  card.innerHTML = `
    <div class="tool-head">
      <span class="tool-dot"></span>
      <span class="tool-name">${escapeHtml(TOOL_LABEL[ev.name] || ev.name)}</span>
      <span class="tool-args">${escapeHtml(extractTarget(ev))}</span>
    </div>
    <div class="tool-result" style="display:none"></div>`;
  $("#timeline").appendChild(card);
  _pendingTools.push(card);
  scrollProc();
}

function tlToolResult(ev) {
  const ok = detectOk(ev);
  const card = _pendingTools.shift();
  if (card) {
    card.classList.add("finished");
    if (!ok) {
      card.classList.add("failed");
      const body = card.querySelector(".tool-result");
      body.textContent = failureText(ev) || "执行失败";
      body.style.display = "block";
    }
  } else if (!ok) {
    tlStatus("⚠ " + (failureText(ev) || "执行失败"), "error");
  }
  scrollProc();
}

function scrollProc() {
  const col = document.querySelector(".process-col");
  col.scrollTop = col.scrollHeight;
}

function renderEvent(ev) {
  switch (ev.type) {
    case "status": tlStatus(ev.text); break;
    case "reasoning": tlReasoning(ev.text); break;
    case "tool_call": tlToolCall(ev); break;
    case "tool_result": tlToolResult(ev); break;
    case "error": tlStatus("⚠ " + ev.text, "error"); break;
    case "done": tlStatus(`✦ DONE / 用时 ${ev.elapsed}s`, "done"); break;
  }
}

/* ---------- 答复解析：正文 + 引用分离 ---------- */
function parseAnswer(markdown) {
  const sections = { body: "", citations: [] };
  if (!markdown) return sections;

  // 按 ## 标题切分
  const parts = markdown.split(/^##\s+/m);
  for (const part of parts) {
    if (/^回答/.test(part)) {
      sections.body = part.replace(/^回答\s*/, "").trim();
    } else if (/^(依据|延伸阅读)/.test(part)) {
      const isExt = /^延伸阅读/.test(part);
      for (const line of part.split("\n")) {
        // 新格式：- [[name]] · path — desc
        let m = line.match(/\[\[([^\]]+)\]\]\s*·\s*([\w\-./\u4e00-\u9fff（）()]+\.md)\s*[—\-–]\s*(.*)/);
        if (m) {
          sections.citations.push({ name: m[1], path: m[2], desc: m[3].trim(), ext: isExt });
          continue;
        }
        // 旧格式兜底：- [[name]] — desc（无路径，不可点击）
        m = line.match(/\[\[([^\]]+)\]\]\s*[—\-–]?\s*(.*)/);
        if (m) {
          sections.citations.push({ name: m[1], path: null, desc: (m[2] || "").trim(), ext: isExt });
        }
      }
    } else if (!sections.body && part.trim() && !part.startsWith("#")) {
      // 没有模板标题时整体作为正文
      sections.body = (sections.body + part).trim();
    }
  }
  if (!sections.body) sections.body = markdown;
  return sections;
}

/* ---------- Wiki 索引：[[wikilink]] → 可点击链接 ---------- */
let WIKI_MAP = null;       // 文件名(不含.md) → 相对路径
let _lastAnswerMd = null;  // 当前展示的答复原文（索引到达后重渲染用）

fetch("/api/wiki-index")
  .then((r) => r.json())
  .then((m) => {
    WIKI_MAP = m;
    if (_lastAnswerMd) renderAnswer(_lastAnswerMd);
  })
  .catch(() => {});

function linkifyWikilinks(md) {
  return md.replace(/\[\[([^\]]+)\]\]/g, (m, name) => {
    const path = WIKI_MAP && WIKI_MAP[name];
    if (path) {
      return `<a class="wl" href="/wiki/${encodeURI(path)}" target="_blank" rel="noopener">[[${name}]]</a>`;
    }
    return `<span class="wl-dead">[[${name}]]</span>`;
  });
}

function renderAnswer(markdown) {
  _lastAnswerMd = markdown;
  const { body, citations } = parseAnswer(markdown);
  $("#answerBody").innerHTML = DOMPurify.sanitize(marked.parse(linkifyWikilinks(body)));

  if (citations.length) {
    const list = $("#citeList");
    list.innerHTML = "";
    for (const c of citations) {
      const card = document.createElement(c.path ? "a" : "div");
      card.className = "cite-card";
      if (c.path) {
        card.href = `/wiki/${encodeURI(c.path)}`;
        card.target = "_blank";
        card.rel = "noopener";
      }
      card.innerHTML = `
        ${c.path ? '<span class="cite-ext">↗</span>' : ""}
        <div class="cite-name">${escapeHtml(c.name)}${c.ext ? ' <span style="color:#555;font-size:12px">· 延伸阅读</span>' : ""}</div>
        ${c.path ? `<div class="cite-path">${escapeHtml(c.path)}</div>` : ""}
        ${c.desc ? `<div class="cite-desc">${escapeHtml(c.desc)}</div>` : ""}`;
      list.appendChild(card);
    }
    $("#citations").classList.remove("hidden");
  }
}

/* ---------- 提问主流程 ---------- */
let currentES = null;

async function ask(question) {
  question = (question || "").trim();
  if (!question) return;
  if (currentES) { currentES.close(); currentES = null; }

  toResults(question);

  let taskId;
  try {
    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    taskId = data.task_id;
  } catch (e) {
    tlStatus("⚠ 后端连接失败，请确认 Flask 服务已启动", "error");
    $("#answerBody").innerHTML = `<p style="color:#ff6b6b">后端连接失败：${escapeHtml(e.message)}</p>`;
    return;
  }

  const record = { id: taskId, question, answer: null, elapsed: null, time: Date.now(), events: [] };
  const es = new EventSource(`/api/stream/${taskId}`);
  currentES = es;

  es.onmessage = (msg) => {
    const ev = JSON.parse(msg.data);
    record.events.push(ev);
    if (ev.type === "answer") {
      record.answer = ev.content;
      renderAnswer(ev.content);
    } else if (ev.type === "done") {
      record.elapsed = ev.elapsed;
      $("#metaLine").textContent = `✦ ${ev.elapsed}s · SESSION ${ev.session_id || "-"}`;
      $("#metaLine").classList.remove("hidden");
      renderEvent(ev);
    } else {
      renderEvent(ev);
      if (ev.type === "error") {
        $("#answerBody").innerHTML = `<p style="color:#ff6b6b">⚠ ${escapeHtml(ev.text)}</p>`;
      }
    }
  };
  es.addEventListener("close", () => {
    es.close();
    currentES = null;
    if (record.answer) addHistory(record);
  });
  es.onerror = () => {
    if (currentES && record.answer) {
      es.close(); currentES = null; addHistory(record);
    }
  };
}

/* ---------- 缓存还原（含过程回放） ---------- */
function showResult(item) {
  toResults(item.question);
  const events = item.events || [];
  if (events.length) {
    for (const ev of events) {
      if (ev.type === "answer") continue;
      renderEvent(ev);
    }
  } else {
    tlStatus("◈ 本地档案还原（旧格式，无过程日志）");
  }
  renderAnswer(item.answer);
  $("#metaLine").textContent = `◈ ARCHIVE / ${new Date(item.time).toLocaleString("zh-CN")} · ${item.elapsed ?? "?"}s`;
  $("#metaLine").classList.remove("hidden");
}

/* ---------- 抽屉 ---------- */
function openDrawer() { $("#drawer").classList.add("open"); $("#drawerMask").classList.add("open"); renderHistory(); }
function closeDrawer() { $("#drawer").classList.remove("open"); $("#drawerMask").classList.remove("open"); }

/* ---------- 事件绑定 ---------- */
$("#mainGo").onclick = () => ask($("#mainInput").value);
$("#mainInput").addEventListener("keydown", (e) => { if (e.key === "Enter") ask(e.target.value); });
$("#topGo").onclick = () => ask($("#topInput").value);
$("#topInput").addEventListener("keydown", (e) => { if (e.key === "Enter") ask(e.target.value); });
document.querySelectorAll(".chip").forEach((c) => (c.onclick = () => ask(c.textContent)));
$("#menuBtn").onclick = openDrawer;
$("#archiveBtn").onclick = openDrawer;
$("#drawerMask").onclick = closeDrawer;
$("#homeLink").onclick = toLanding;
$("#clearBtn").onclick = () => { if (confirm("清空全部检索档案？")) { saveHistory([]); renderHistory(); } };
$("#exportBtn").onclick = () => {
  const blob = new Blob([JSON.stringify(loadHistory(), null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `wiki-ask-archive-${Date.now()}.json`;
  a.click();
};
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

renderHistory();
