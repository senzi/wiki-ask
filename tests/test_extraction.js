// ============================================================
// ⚠️ 注意：本文件中的 extractTarget / detectOk / failureText
// 是 static/app.js 同名函数的【镜像副本】，用于离线验证推断逻辑。
// 修改 app.js 中的这些函数时，必须同步修改这里，否则测试会失去意义。
// （刻意不 import 生产代码：保持项目"无构建纯静态"的结构。）
// ============================================================
// 用真实数据验证展示推断逻辑（与 app.js 当前版本保持一致）
function _tryParse(s) { try { return JSON.parse(s); } catch { return null; } }

function extractTarget(ev) {
  if (ev.label) return ev.label;
  const name = ev.name;
  const s = ev.args || ev.preview || "";
  const a = _tryParse(s);
  if (a && typeof a === "object") {
    if (name === "read_file" && a.path) return String(a.path).replace(/\\/g, "/").split("/").pop() || "某个文件";
    if (name === "search_files") return a.pattern || a.file_glob || "某个关键词";
    if (name === "terminal" && a.command) return String(a.command).slice(0, 60);
    if (name === "skill_view") return a.name || "";
  }
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
  if (ev.ok !== undefined) return ev.ok;
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

function linkify(md, map) {
  return md.replace(/\[\[([^\]]+)\]\]/g, (m, name) => {
    const path = map && map[name];
    if (path) return `<a class="wl" href="/wiki/${encodeURI(path)}" target="_blank" rel="noopener">[[${name}]]</a>`;
    return `<span class="wl-dead">[[${name}]]</span>`;
  });
}

let pass = 0, fail = 0;
function eq(got, expect, msg) {
  const ok = got === expect;
  ok ? pass++ : fail++;
  console.log(`${ok ? "✓" : "✗"} ${msg}${ok ? "" : ` → got ${JSON.stringify(got)}, expect ${JSON.stringify(expect)}`}`);
}

// --- 当前格式（args/raw 完整 JSON）---
eq(extractTarget({ name: "read_file", args: JSON.stringify({ path: "D:\\wiki\\entities\\MD5.md" }) }), "MD5.md", "args→文件名");
eq(extractTarget({ name: "search_files", args: JSON.stringify({ pattern: "MD5", path: "D:/wiki" }) }), "MD5", "args→关键词");
eq(extractTarget({ name: "read_file", args: "not json" }), "某个文件", "乱码→退化");
eq(detectOk({ raw: JSON.stringify({ content: "1|...", total_lines: 182 }) }), true, "raw 成功");
eq(detectOk({ raw: JSON.stringify({ total_count: 0, error: "Search failed: rg..." }) }), false, "raw 失败(error)");
eq(detectOk({ raw: JSON.stringify({ output: "", exit_code: 2 }) }), false, "raw 失败(exit_code)");

// --- 旧档案格式（preview 截断 JSON）---
eq(extractTarget({ name: "read_file", preview: '{"limit":300,"path":"D:\\\\notes\\\\wiki\\\\index.md"}' }), "index.md", "旧档案→文件名");
eq(extractTarget({ name: "search_files", preview: '{"path":"D:\\\\notes\\\\wiki","pattern":"MD5"}' }), "MD5", "旧档案→关键词");
eq(detectOk({ preview: '{"total_count": 0, "error": "Search failed: rg: /d/xx (os error 3)"}' }), false, "旧档案→失败");

// --- wikilink 链接化 ---
const map = { "Joux多重碰撞攻击": "entities/Joux多重碰撞攻击.md", "生日攻击": "knowledge/生日攻击.md" };
const md = "利用 [[Joux多重碰撞攻击]] 和 [[不存在的页面]] 说明";
const out = linkify(md, map);
eq(out.includes('class="wl"') && out.includes(encodeURI("entities/Joux多重碰撞攻击.md")), true, "已知链接→超链接");
eq(out.includes('<span class="wl-dead">[[不存在的页面]]</span>'), true, "未知链接→死链样式");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
