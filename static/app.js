/* 析问 · Wiki Ask 前端逻辑 — Hermes 桌面端风格过程展示 */
const $ = (s) => document.querySelector(s);

/* ---------- 站点文案（后端 /api/site-config，可被 config.json 覆盖） ---------- */
const SITE = {
  name: "Wiki Ask",
  subtitle: "KNOWLEDGE RETRIEVAL",
  footer: "",
  search_placeholder: "Ask your knowledge base…",
  archive_label: "◈ ARCHIVE",
  drawer_title: "◈ ARCHIVE",
  thinking_text: "Agent 正在翻阅 Wiki…",
  preset_questions: [],
};

fetch("/api/site-config")
  .then((r) => (r.ok ? r.json() : null))
  .then((cfg) => { if (cfg) applySite({ ...SITE, ...cfg }); })
  .catch(() => {});

function applySite(s) {
  Object.assign(SITE, s);
  document.title = s.name;
  $("#siteName").textContent = s.name;
  $("#siteSubtitle").textContent = s.subtitle;
  $("#homeLink").textContent = s.name;
  $("#siteFooter").textContent = s.footer;
  $("#mainInput").placeholder = s.search_placeholder;
  $("#archiveBtn").textContent = s.archive_label;
  $("#drawerTitle").textContent = s.drawer_title;
  // 预设问题 chips
  const chips = $("#chips");
  chips.innerHTML = "";
  if (s.preset_questions && s.preset_questions.length) {
    const label = document.createElement("span");
    label.className = "chips-label";
    label.textContent = "TRY //";
    chips.appendChild(label);
    for (const q of s.preset_questions) {
      const b = document.createElement("button");
      b.className = "chip";
      b.textContent = q;
      b.onclick = () => ask(q);
      chips.appendChild(b);
    }
  }
}

const LS_KEY = "wiki-ask-history-v2";

/* ---------- 历史记录（localStorage，含过程日志 + 多版本） ----------
   结构：{question, time, elapsed, versions: [{id, answer, elapsed, time, events}, ...]}
   versions 最新在前，上限 5 个；前端永远只展示最新版本。 */
const MAX_VERSIONS = 5;

function loadHistory() {
  let list;
  try { list = JSON.parse(localStorage.getItem(LS_KEY)) || []; }
  catch { list = []; }
  // 旧格式迁移：无 versions 的条目包一层
  return list.map((x) => x.versions ? x : {
    question: x.question,
    time: x.time,
    elapsed: x.elapsed,
    versions: [{ id: x.id, answer: x.answer, elapsed: x.elapsed, time: x.time, events: x.events || [] }],
  });
}
function saveHistory(list) {
  const trimmed = list.slice(0, 100).map((x) => ({
    ...x,
    versions: x.versions.map((v) => ({ ...v, events: (v.events || []).slice(0, 300) })),
  }));
  try { localStorage.setItem(LS_KEY, JSON.stringify(trimmed)); }
  catch {
    trimmed.pop(); saveHistory(trimmed);
  }
}
function addHistory(record) {
  const list = loadHistory();
  const version = { id: record.id, answer: record.answer, elapsed: record.elapsed, time: record.time, events: record.events };
  const existing = list.find((x) => x.question === record.question);
  if (existing) {
    existing.versions.unshift(version);
    existing.versions = existing.versions.slice(0, MAX_VERSIONS);
    existing.time = record.time;
    existing.elapsed = record.elapsed;
    list.splice(list.indexOf(existing), 1);
    list.unshift(existing);
  } else {
    list.unshift({ question: record.question, time: record.time, elapsed: record.elapsed, versions: [version] });
  }
  saveHistory(list);
  renderHistory();
}
function findCached(question) {
  return loadHistory().find((x) => x.question === question) || null;
}
function delHistory(question) {
  saveHistory(loadHistory().filter((x) => x.question !== question));
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
    const latest = item.versions[0];
    // 步数与时间线实际渲染的元素对齐：tool_result 并入工具卡片、answer 不在时间线
    const steps = (latest.events || []).filter((e) => e.type !== "answer" && e.type !== "tool_result").length;
    const vInfo = item.versions.length > 1 ? ` · v${item.versions.length}` : "";
    div.innerHTML = `
      <div class="hist-q"></div>
      <div class="hist-t">${d.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} · ${latest.elapsed ?? "?"}s · ${steps} 步${vInfo}</div>
      <button class="hist-del" title="删除">✕</button>`;
    div.querySelector(".hist-q").textContent = item.question;
    div.querySelector(".hist-del").onclick = (e) => { e.stopPropagation(); delHistory(item.question); };
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
      <span class="thinking-text">${escapeHtml(SITE.thinking_text)}</span>
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
        // 新格式：- [[name]] · path — desc（路径允许任意非空白字符，含 å 等非 ASCII）
        let m = line.match(/\[\[([^\]]+)\]\]\s*·\s*([^\s]+?\.md)\s*[—\-–]\s*(.*)/);
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

/* ---------- Wiki 索引：[[wikilink]] → 可点击链接（DOM 级替换） ---------- */
let WIKI_MAP = null;       // 文件名(不含.md) → 相对路径
let _lastAnswerMd = null;  // 当前展示的答复原文（索引到达后重渲染用）

fetch("/api/wiki-index")
  .then((r) => r.ok ? r.json() : null)
  .then((m) => {
    WIKI_MAP = m;
    if (m && _lastAnswerMd) renderAnswer(_lastAnswerMd);
  })
  .catch(() => {});

// 在渲染后的 DOM 里做文本节点替换，绕过 marked/DOMPurify 的一切不确定性
function linkifyDom(container) {
  if (!WIKI_MAP) return;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (node.parentElement.closest("a")) continue;
    const text = node.nodeValue;
    if (!/\[\[([^\]]+)\]\]/.test(text)) continue;
    const frag = document.createDocumentFragment();
    const re = /\[\[([^\]]+)\]\]/g;
    let m, last = 0;
    while ((m = re.exec(text))) {
      frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const name = m[1].normalize("NFC");
      const path = WIKI_MAP[name];
      const el = document.createElement(path ? "a" : "span");
      el.className = path ? "wl" : "wl-dead";
      el.textContent = `[[${name}]]`;
      if (path) {
        el.href = `/wiki/${encodeURI(path)}`;
        el.target = "_blank";
        el.rel = "noopener";
      }
      frag.appendChild(el);
      last = m.index + m[0].length;
    }
    frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
}

function renderAnswer(markdown) {
  _lastAnswerMd = markdown;
  const { body, citations } = parseAnswer(markdown);
  const answerEl = $("#answerBody");
  answerEl.innerHTML = DOMPurify.sanitize(marked.parse(body));
  linkifyDom(answerEl);

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

async function ask(question, force = false) {
  question = (question || "").trim();
  if (!question) return;
  if (currentES) { currentES.close(); currentES = null; }

  // 完全相同的问题命中缓存：不调用 Agent，直接展示最新版本
  if (!force) {
    const hit = findCached(question);
    if (hit) { showResult(hit); return; }
  }

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

/* ---------- 缓存还原（含过程回放，永远展示最新版本） ---------- */
function showResult(item) {
  const v = item.versions[0];
  toResults(item.question);
  const events = v.events || [];
  if (events.length) {
    tlStatus("◈ 命中本地缓存 · 未消耗 API（点「重新生成」可再次调用 Agent）");
    for (const ev of events) {
      if (ev.type === "answer") continue;
      renderEvent(ev);
    }
  } else {
    tlStatus("◈ 本地档案还原（旧格式，无过程日志）");
  }
  renderAnswer(v.answer);
  const vInfo = item.versions.length > 1 ? ` · 共 ${item.versions.length} 个版本（展示最新）` : "";
  $("#metaLine").textContent = `◈ ARCHIVE / ${new Date(v.time).toLocaleString("zh-CN")} · ${v.elapsed ?? "?"}s${vInfo}`;
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
$("#homeBtn").onclick = toLanding;
$("#clearBtn").onclick = () => { if (confirm("清空全部检索档案？")) { saveHistory([]); renderHistory(); } };
$("#exportBtn").onclick = () => {
  const blob = new Blob([JSON.stringify(loadHistory(), null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `wiki-ask-archive-${Date.now()}.json`;
  a.click();
};
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
$("#regenBtn").onclick = () => ask($("#qTitle").textContent, /*force=*/true);

/* ---------- 后端版本检测：过旧则提示重启 ---------- */
const EXPECTED_VERSION = "2026-07-27.2";
fetch("/api/version")
  .then((r) => (r.ok ? r.json() : null))
  .then((v) => { if (!v || v.version !== EXPECTED_VERSION) staleBanner(); })
  .catch(() => staleBanner());
function staleBanner() {
  if (document.querySelector(".stale-banner")) return;
  const b = document.createElement("div");
  b.className = "stale-banner";
  b.textContent = "⚠ 后端版本过旧，部分功能不可用（如 wikilink 跳转）——请重启 Flask 服务";
  document.body.prepend(b);
}

renderHistory();
