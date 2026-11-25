// DevStation Web Translate — chèn vào trang ngoài (initialization_script). Dịch chữ trên trang theo thời gian thực:
// gom text node + vài thuộc tính (placeholder/title/alt/aria-label/nút), ưu tiên phần đang thấy (IntersectionObserver),
// dịch theo lô qua `plugin:webtr|translate` (lệnh duy nhất trang ngoài được gọi), theo dõi DOM đổi (MutationObserver).
// Bắt đầu NGAY khi tài liệu được tạo (dịch dần trong lúc trang đang tải), che trang (veil) tới khi phần đầu dịch xong
// (tối đa ~1.2s sau DOMContentLoaded) để không thấy chữ gốc nháy. Thanh nổi (shadow DOM) chuyển Bản gốc ↔ Bản dịch.
// Không đụng code/ô nhập/vùng [translate=no]/.notranslate.
(function () {
  "use strict";
  if (window.top !== window || window.__DSTR_RUNNING__) return;
  window.__DSTR_RUNNING__ = true;
  var BOOT = window.__DSTR_BOOT__ || { ui: {} };
  var UI = BOOT.ui || {};
  var T = function (k, d) { return UI[k] || d; };

  var SKIP = { HEAD: 1, TITLE: 1, SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, CODE: 1, PRE: 1, KBD: 1, SAMP: 1, VAR: 1, TEXTAREA: 1, INPUT: 1, SELECT: 1,
    OPTION: 1, SVG: 1, MATH: 1, CANVAS: 1, IFRAME: 1, TEMPLATE: 1, OBJECT: 1, EMBED: 1 };
  var ATTRS = ["placeholder", "title", "alt", "aria-label"];
  var HAS_LETTER = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ֐-ۿ฀-๿぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/;
  var PARALLEL = 6;

  var showTranslated = true;
  var memo = new Map();          // câu gốc (đã trim) → bản dịch
  var textItems = new Map();     // text node → { orig, tr }  (tr = chuỗi ta đã đặt)
  var attrItems = new Map();     // element → { attr: { orig, tr } }
  var pendingByEl = new Map();   // element → Set(text node | "@attr")
  var queue = [];                // { kind: "t", node } | { kind: "a", el, attr }
  var inflight = 0, done = 0, total = 0, failedUntil = 0, lastErr = "", sentAny = false;
  var host = null, ui = null;

  /* ── Veil: che body tới khi phần đang thấy đã dịch (hoặc hết giờ) ── */
  var veilOn = false, unveilTimer = 0;
  function veil() {
    var de = document.documentElement;
    if (!de) return;
    var st = document.createElement("style");
    st.setAttribute("data-dstr", "");
    st.textContent = "html.dstr-veil body{opacity:0!important}html.dstr-shown body{transition:opacity .18s ease}";
    de.appendChild(st);
    de.classList.add("dstr-veil");
    veilOn = true;
    setTimeout(unveil, 3000); // chặn trên tuyệt đối
  }
  function unveil() {
    if (!veilOn) return;
    veilOn = false;
    var de = document.documentElement;
    de.classList.add("dstr-shown");
    de.classList.remove("dstr-veil");
  }
  /** Gỡ veil khi không còn gì đang dịch trong vùng đang thấy (đã qua DOMContentLoaded). */
  function maybeUnveil() {
    // Cần: đã qua DOMContentLoaded ~120ms (để IntersectionObserver kịp đưa phần đang thấy vào hàng), hết lô đang chạy.
    if (veilOn && domReady && Date.now() - readyAt > 120 && inflight === 0 && queue.length === 0 && (sentAny || total === 0)) unveil();
    else if (veilOn && domReady && !unveilTimer) unveilTimer = setTimeout(function () { unveilTimer = 0; maybeUnveil(); }, 60);
  }

  function skipEl(el) {
    for (var e = el; e && e.nodeType === 1; e = e.parentElement) {
      if (SKIP[e.tagName]) return true;
      if (e === host) return true;
      if (e.isContentEditable) return true;
      if (e.getAttribute("translate") === "no") return true;
      if (e.classList && e.classList.contains("notranslate")) return true;
    }
    return false;
  }

  function want(text) {
    var t = text.trim();
    return t.length > 0 && t.length <= 4000 && HAS_LETTER.test(t);
  }

  /* ── Dịch THEO ĐOẠN, không theo mẩu chữ: mỗi khối (p, li, td, nút…) gom mọi text node đi qua phần tử inline
   * (a, b, span, em…) thành MỘT câu, đánh dấu từng mẩu bằng <a i=N>…</a> và dịch ở chế độ HTML → dịch vụ thấy trọn câu
   * (không còn word-by-word) mà vẫn trả lại đúng phần thuộc link/chữ đậm; kết quả tách lại theo i rồi ghi vào đúng text
   * node gốc (không thay innerHTML → giữ nguyên sự kiện/React state của trang). ── */
  var INLINE = { A: 1, ABBR: 1, B: 1, BDI: 1, BDO: 1, BIG: 1, BR: 1, CITE: 1, DATA: 1, DEL: 1, DFN: 1, EM: 1, FONT: 1, I: 1, INS: 1,
    LABEL: 1, MARK: 1, NOBR: 1, Q: 1, S: 1, SMALL: 1, SPAN: 1, STRIKE: 1, STRONG: 1, SUB: 1, SUP: 1, TIME: 1, TT: 1, U: 1, WBR: 1 };
  var UNIT_CHARS = 1200, UNIT_NODES = 40;
  var tpl = document.createElement("template"); // nội dung template là inert → đọc HTML kết quả an toàn

  function esc(t) { return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function textOf(html) { tpl.innerHTML = html; return tpl.content.textContent || ""; }
  function blocked(el) {
    return el === host || SKIP[el.tagName] || el.getAttribute("translate") === "no" || (el.classList && el.classList.contains("notranslate"));
  }
  /** Khối chứa text node: đi lên qua các phần tử inline. */
  function segRoot(node) {
    var e = node.parentElement;
    while (e && INLINE[e.tagName] && e.parentElement && e.parentElement !== document.documentElement) e = e.parentElement;
    return e;
  }
  /** Text node của khối theo thứ tự đọc, chỉ đi qua phần tử inline (khối con là đoạn riêng). */
  function collect(root) {
    var out = [];
    (function walk(el) {
      for (var c = el.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) { if (c.nodeValue.trim()) out.push(c); }
        else if (c.nodeType === 1 && INLINE[c.tagName] && !blocked(c) && !c.isContentEditable) walk(c);
      }
    })(root);
    return out;
  }
  /** Dựng các "đơn vị dịch" của khối (khối quá dài → chia nhiều đơn vị theo mẩu liên tiếp). */
  function buildUnits(root) {
    if (!root.isConnected || skipEl(root)) return [];
    var nodes = collect(root);
    if (!nodes.some(function (n) { return want(n.nodeValue) || (textItems.get(n) && want(textItems.get(n).orig)); })) return [];
    var units = [], cur = null, chars = 0;
    nodes.forEach(function (n) {
      var it = textItems.get(n), v = n.nodeValue;
      if (!it || (v !== it.tr && v !== it.orig)) { it = { orig: v, tr: null }; textItems.set(n, it); }
      var l = it.orig.length;
      if (!cur || cur.nodes.length >= UNIT_NODES || chars + l > UNIT_CHARS) { cur = { nodes: [], origs: [] }; units.push(cur); chars = 0; }
      cur.nodes.push(n); cur.origs.push(it.orig); chars += l;
    });
    return units.filter(function (u) {
      // Đã dịch hết và chưa đổi → bỏ qua; không có chữ nào cần dịch → bỏ qua.
      var allDone = u.nodes.every(function (n) { var it = textItems.get(n); return it.tr != null && n.nodeValue === it.tr; });
      return !allDone && u.origs.some(want);
    }).map(function (u) {
      if (u.nodes.length === 1) { u.key = esc(u.origs[0].trim()); return u; }
      var k = "";
      u.origs.forEach(function (o, i) {
        if (i > 0 && /^\s/.test(o)) k += " ";
        k += "<a i=" + i + ">" + esc(o.trim()) + "</a>";
        if (/\s$/.test(o)) k += " ";
      });
      u.key = k.trim();
      return u;
    });
  }

  /* ── Ưu tiên phần đang thấy: khối vào khung nhìn (±1000px) mới dựng đơn vị + đưa vào hàng dịch ── */
  var pendingRoots = new Set();
  var io = typeof window.IntersectionObserver === "function" ? new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (!en.isIntersecting) return;
      var el = en.target;
      io.unobserve(el);
      if (pendingRoots.delete(el)) buildUnits(el).forEach(function (u) { total++; enqueue({ kind: "s", unit: u }); });
      var set = pendingByEl.get(el);
      pendingByEl.delete(el);
      if (set) set.forEach(function (x) { enqueue({ kind: "a", el: el, attr: x.slice(1) }); });
    });
  }, { rootMargin: "1000px 0px" }) : null;
  var rootsNoIo = new Set();

  function deferRoot(root) {
    if (!io) { rootsNoIo.add(root); schedule(); return; }
    if (pendingRoots.has(root)) return;
    pendingRoots.add(root);
    io.observe(root);
  }
  function deferAttr(el, attr) {
    total++;
    if (!io) { enqueue({ kind: "a", el: el, attr: attr }); return; }
    var set = pendingByEl.get(el);
    if (!set) { set = new Set(); pendingByEl.set(el, set); io.observe(el); }
    set.add("@" + attr);
  }

  function keyOf(item) {
    if (item.kind === "s") return item.unit.key;
    var rec = attrItems.get(item.el), r = rec && rec[item.attr];
    return r ? esc(r.orig.trim()) : null;
  }

  function enqueue(item) {
    var k = keyOf(item);
    if (k == null) return;
    // Đã có bản dịch (đoạn lặp lại: menu, footer…) → thay ngay, không chờ lô.
    if (memo.has(k)) { apply(item, memo.get(k)); done++; return; }
    queue.push(item);
    schedule();
  }

  function scanText(node) {
    var it = textItems.get(node);
    var v = node.nodeValue;
    if (it && (v === it.tr || v === it.orig)) return; // của mình, hoặc đang hiện bản gốc
    if (!want(v)) return;
    var el = node.parentElement;
    if (!el || skipEl(el)) return;
    var root = segRoot(node);
    if (root) deferRoot(root);
  }

  function scanAttrs(el) {
    if (el === host || (el.parentElement && skipEl(el.parentElement))) return;
    var names = ATTRS.slice();
    if (el.tagName === "INPUT" && /^(button|submit|reset)$/i.test(el.type)) names.push("value");
    var rec = attrItems.get(el);
    names.forEach(function (a) {
      var v = el.getAttribute(a);
      if (v == null || !want(v)) return;
      var r = rec && rec[a];
      if (r && (v === r.tr || v === r.orig)) return;
      if (!rec) { rec = {}; attrItems.set(el, rec); }
      rec[a] = { orig: v, tr: null };
      deferAttr(el, a);
    });
  }

  function scan(root) {
    if (!root) return;
    if (root.nodeType === 3) { scanText(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1) {
      if (root === host) return;
      if (root.tagName === "INPUT" || root.tagName === "TEXTAREA") { scanAttrs(root); return; }
      if (SKIP[root.tagName]) return;
      if (root.hasAttribute && (root.hasAttribute("title") || root.hasAttribute("alt") || root.hasAttribute("aria-label") || root.hasAttribute("placeholder"))) scanAttrs(root);
    }
    var els = root.querySelectorAll("[placeholder],[title],[alt],[aria-label],input[type=button],input[type=submit],input[type=reset]");
    for (var i = 0; i < els.length; i++) scanAttrs(els[i]);
    // Duyệt cây bằng ngăn xếp (không dùng TreeWalker): cắt luôn nhánh SKIP / translate=no / thanh nổi.
    var stack = [root];
    while (stack.length) {
      var n = stack.pop();
      for (var c = n.lastChild; c; c = c.previousSibling) {
        if (c.nodeType === 3) scanText(c);
        else if (c.nodeType === 1 && !blocked(c)) stack.push(c);
      }
    }
  }

  /* ── Hàng dịch: lô đầu gửi gần như ngay (16ms, nhỏ để có kết quả sớm), sau đó gom 50ms; tối đa 6 lô song song ── */
  var timer = 0;
  function schedule() {
    if (timer) return;
    timer = setTimeout(function () { timer = 0; pump(); }, sentAny ? 50 : 16);
  }

  function inLink(node) {
    for (var e = node.parentElement; e && INLINE[e.tagName]; e = e.parentElement) if (e.tagName === "A") return true;
    return false;
  }

  /** Ghi kết quả HTML của một đoạn vào đúng các text node gốc. */
  function applyUnit(u, html) {
    var n = u.nodes.length, pieces = [], ws = [];
    if (n === 1) pieces[0] = textOf(html);
    else {
      tpl.innerHTML = html;
      var cur = -1, pre = "", tagged = false;
      tpl.content.childNodes.forEach(function (c) {
        var k = c.nodeType === 1 && c.getAttribute ? parseInt(c.getAttribute("i"), 10) : NaN;
        if (!isNaN(k) && k >= 0 && k < n) { cur = k; tagged = true; pieces[k] = (pieces[k] || "") + c.textContent; }
        else if (cur >= 0) pieces[cur] += c.textContent;
        else pre += c.textContent;
      });
      if (!tagged) { pieces = [pre]; pre = ""; }
      if (pre) { var f0 = pieces.findIndex(function (p) { return p != null; }); if (f0 >= 0) pieces[f0] = pre + pieces[f0]; }
    }
    for (var i = 0; i < n; i++) {
      var node = u.nodes[i], it = textItems.get(node);
      if (!it) continue;
      var o = it.orig, p = pieces[i];
      if (p == null || !p.trim()) {
        // Mẩu bị dịch vụ gộp sang mẩu khác: mẩu chỉ có số/ký hiệu thì để trống; còn chữ (vd chữ trong link) thì giữ nguyên gốc.
        if (want(o) && p == null) { it.tr = o; continue; }
        p = "";
      }
      // Khoảng trắng dịch vụ chèn giữa hai mẩu (vd nguồn tiếng Trung không có dấu cách) đặt ở ĐẦU mẩu sau,
      // không nhét vào cuối mẩu trước (tránh gạch chân thừa trong link).
      var lead = o.match(/^\s*/)[0], trail = o.match(/\s*$/)[0], core = p.trim();
      if (!lead && i > 0 && ws[i - 1] && !/^[,.;:!?)\]}%，。、；：！？）」』]/.test(core)) {
        // Mẩu trước nằm trong link còn mẩu này không → cách ở đầu mẩu này; ngược lại → cách ở cuối mẩu trước.
        var prev = u.nodes[i - 1], pit = textItems.get(prev);
        if (!inLink(node) || inLink(prev) || !pit || pit.tr == null) lead = " ";
        else { pit.tr += " "; if (showTranslated && prev.nodeValue === pit.tr.slice(0, -1)) prev.nodeValue = pit.tr; }
      }
      ws[i] = !trail && /\s$/.test(p);
      var t = lead + core + trail;
      it.tr = t;
      if (showTranslated && node.nodeValue === o) node.nodeValue = t;
    }
  }

  function apply(item, html) {
    if (item.kind === "s") { applyUnit(item.unit, html); return; }
    var rec = attrItems.get(item.el), r = rec && rec[item.attr];
    if (!r) return;
    r.tr = textOf(html).trim();
    if (showTranslated && item.el.getAttribute(item.attr) === r.orig) item.el.setAttribute(item.attr, r.tr);
  }

  function pump() {
    if (!showTranslated) return;
    if (rootsNoIo.size) {
      var rs = Array.from(rootsNoIo);
      rootsNoIo.clear();
      rs.forEach(function (r) { buildUnits(r).forEach(function (u) { total++; enqueue({ kind: "s", unit: u }); }); });
    }
    if (Date.now() < failedUntil) { setTimeout(schedule, failedUntil - Date.now() + 10); return; }
    while (queue.length && inflight < PARALLEL) {
      // Lô nhỏ khi chưa có lô nào xong (phần đang thấy hiện sớm), lớn dần sau đó.
      var maxItems = done < 60 ? 30 : 150;
      var batch = [], texts = [], seen = {}, chars = 0;
      while (queue.length && batch.length < maxItems && chars < 25000) {
        var item = queue.shift();
        var key = keyOf(item);
        if (key == null) continue;
        if (memo.has(key)) { apply(item, memo.get(key)); done++; continue; }
        batch.push({ item: item, key: key });
        if (!seen[key]) { seen[key] = 1; texts.push(key); chars += key.length; }
      }
      if (!texts.length) continue;
      send(batch, texts);
    }
    status();
    maybeUnveil();
  }

  function send(batch, texts) {
    var ipc = window.__TAURI_INTERNALS__;
    if (!ipc || !ipc.invoke) { lastErr = T("noBridge", "Không kết nối được DevStation"); unveil(); status(); return; }
    inflight++;
    sentAny = true;
    ipc.invoke("plugin:webtr|translate", { texts: texts, html: true }).then(function (res) {
      for (var i = 0; i < texts.length; i++) memo.set(texts[i], res[i] != null ? String(res[i]) : texts[i]);
      batch.forEach(function (b) { apply(b.item, memo.get(b.key)); done++; });
      lastErr = "";
    }, function (e) {
      lastErr = String(e && e.message || e);
      failedUntil = Date.now() + 8000;
      batch.forEach(function (b) { queue.push(b.item); });
      unveil();
    }).then(function () {
      inflight--;
      status();
      if (queue.length) schedule();
      maybeUnveil();
    });
  }

  /* ── Bản gốc ↔ bản dịch ── */
  function setMode(tr) {
    if (tr === showTranslated) return;
    showTranslated = tr;
    observer && observer.disconnect();
    textItems.forEach(function (it, node) {
      if (!node.isConnected) { textItems.delete(node); return; }
      if (it.tr == null) return;
      node.nodeValue = tr ? it.tr : it.orig;
    });
    attrItems.forEach(function (rec, el) {
      if (!el.isConnected) { attrItems.delete(el); return; }
      for (var a in rec) if (rec[a].tr != null) el.setAttribute(a, tr ? rec[a].tr : rec[a].orig);
    });
    titleApply();
    observe();
    if (tr) { scan(document.body); schedule(); }
    status();
  }

  /* ── Tiêu đề trang ── */
  var titleOrig = null, titleTr = null;
  function titleScan() {
    var t = document.title;
    if (!t || t === titleTr || !want(t)) return;
    titleOrig = t;
    var key = esc(t.trim());
    if (memo.has(key)) { titleTr = textOf(memo.get(key)).trim(); titleApply(); return; }
    var ipc = window.__TAURI_INTERNALS__;
    if (!ipc || !ipc.invoke) return;
    ipc.invoke("plugin:webtr|translate", { texts: [key], html: true }).then(function (r) {
      memo.set(key, r[0]); titleTr = textOf(String(r[0])).trim(); titleApply();
    }, function () {});
  }
  function titleApply() {
    if (titleOrig == null || titleTr == null) return;
    var w = showTranslated ? titleTr : titleOrig;
    if (document.title !== w) document.title = w;
  }

  /* ── Theo dõi DOM (từ lúc tài liệu vừa tạo → dịch dần trong khi trang đang tải) ── */
  var observer = null, titleObs = null;
  function observe() {
    if (!document.documentElement) return;
    if (!observer) observer = new MutationObserver(function (muts) {
      if (!showTranslated) return;
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === "childList") { for (var j = 0; j < m.addedNodes.length; j++) scan(m.addedNodes[j]); }
        else if (m.type === "characterData") scanText(m.target);
        else if (m.type === "attributes" && m.target.nodeType === 1) scanAttrs(m.target);
      }
      if (!titleObs) watchTitle();
    });
    observer.observe(document.documentElement, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ["placeholder", "title", "alt", "aria-label", "value"],
    });
  }
  function watchTitle() {
    var el = document.querySelector("head > title");
    if (!el) return;
    titleObs = new MutationObserver(function () { if (showTranslated) titleScan(); });
    titleObs.observe(el, { childList: true, characterData: true, subtree: true });
    titleScan();
  }

  /* ── Link target=_blank → mở ngay trong cửa sổ này (cửa sổ mới sẽ không được dịch) ── */
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a[target]") : null;
    if (!a || e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
    var t = (a.getAttribute("target") || "").toLowerCase();
    if (t && t !== "_self" && t !== "_top" && t !== "_parent" && a.href && /^https?:/i.test(a.href)) {
      e.preventDefault();
      location.href = a.href;
    }
  }, true);
  var openOrig = window.open;
  window.open = function (u) {
    try { if (u && /^https?:|^\//i.test(String(u))) { location.href = new URL(String(u), location.href).href; return null; } } catch (_) {}
    return openOrig.apply(window, arguments);
  };

  /* ── Thanh nổi (shadow DOM đóng; gắn vào <html> để veil trên body không che nó) ── */
  var ICON_LANG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg>';
  var ICON_BACK = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>';
  var ICON_RELOAD = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>';
  var ICON_MIN = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg>';

  function buildBar() {
    if (host || !document.documentElement) return;
    host = document.createElement("devstation-translate");
    host.setAttribute("translate", "no");
    host.style.cssText = "all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;";
    var root = host.attachShadow({ mode: "closed" });
    root.innerHTML =
      "<style>" +
      ":host{all:initial}" +
      ".b{position:relative;display:flex;align-items:center;gap:6px;padding:5px;border-radius:999px;color:#e6edf3;" +
      "font:500 12px/1 'Segoe UI Variable','Segoe UI',system-ui,sans-serif;background:rgba(22,27,34,.82);" +
      "-webkit-backdrop-filter:blur(14px) saturate(1.4);backdrop-filter:blur(14px) saturate(1.4);" +
      "border:1px solid rgba(240,246,252,.12);box-shadow:0 8px 28px rgba(0,0,0,.35),0 1px 0 rgba(255,255,255,.04) inset;" +
      "overflow:hidden;transition:opacity .2s,transform .2s;user-select:none}" +
      ".b:not(:hover){opacity:.9}" +
      ".ic{display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#d29922,#f0883e);color:#fff;flex:none;cursor:pointer}" +
      ".st{display:flex;align-items:center;gap:6px;padding:0 4px;color:#9aa4af;white-space:nowrap;max-width:240px;overflow:hidden;text-overflow:ellipsis}" +
      ".st.err{color:#ff7b72}" +
      ".dot{width:6px;height:6px;border-radius:50%;background:#3fb950;flex:none}" +
      ".busy .dot{background:#d29922;animation:p 1s ease-in-out infinite}" +
      ".err .dot{background:#f85149;animation:none}" +
      "@keyframes p{50%{opacity:.25;transform:scale(.7)}}" +
      ".seg{display:flex;padding:2px;border-radius:999px;background:rgba(110,118,129,.18)}" +
      ".seg button{all:unset;cursor:pointer;padding:6px 11px;border-radius:999px;color:#9aa4af;transition:background .15s,color .15s}" +
      ".seg button:hover{color:#e6edf3}" +
      ".seg button.on{background:#1f6feb;color:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3)}" +
      ".btn{all:unset;cursor:pointer;display:grid;place-items:center;width:26px;height:26px;border-radius:50%;color:#9aa4af}" +
      ".btn:hover{background:rgba(110,118,129,.25);color:#e6edf3}" +
      ".sep{width:1px;height:16px;background:rgba(240,246,252,.12)}" +
      ".pg{position:absolute;left:0;bottom:0;height:2px;background:linear-gradient(90deg,#1f6feb,#a371f7);transition:width .3s,opacity .4s}" +
      ".min .st,.min .seg,.min .btn,.min .sep{display:none}" +
      ".min{padding:4px}" +
      "</style>" +
      '<div class="b">' +
      '<span class="ic" title="DevStation Translate">' + ICON_LANG + "</span>" +
      '<span class="st"><span class="dot"></span><span class="tx"></span></span>' +
      '<span class="seg"><button class="o"></button><button class="t"></button></span>' +
      '<span class="sep"></span>' +
      '<button class="btn back" title="Back">' + ICON_BACK + "</button>" +
      '<button class="btn rl" title="Reload">' + ICON_RELOAD + "</button>" +
      '<button class="btn mn" title="—">' + ICON_MIN + "</button>" +
      '<span class="pg"></span>' +
      "</div>";
    var bar = root.querySelector(".b");
    ui = { bar: bar, st: root.querySelector(".st"), tx: root.querySelector(".tx"), o: root.querySelector(".o"), t: root.querySelector(".t"), pg: root.querySelector(".pg") };
    ui.o.textContent = T("showOriginal", "Bản gốc");
    ui.t.textContent = T("targetName", BOOT.to || "Dịch");
    ui.o.addEventListener("click", function () { setMode(false); });
    ui.t.addEventListener("click", function () { setMode(true); });
    root.querySelector(".back").addEventListener("click", function () { history.back(); });
    root.querySelector(".rl").addEventListener("click", function () { location.reload(); });
    var toggleMin = function () { bar.classList.toggle("min"); };
    root.querySelector(".mn").addEventListener("click", toggleMin);
    root.querySelector(".ic").addEventListener("click", function () { if (bar.classList.contains("min")) toggleMin(); });
    document.documentElement.appendChild(host);
    status();
  }

  var statusRaf = 0;
  function status() {
    if (!ui || statusRaf) return;
    statusRaf = requestAnimationFrame(function () {
      statusRaf = 0;
      ui.o.className = showTranslated ? "o" : "o on";
      ui.t.className = showTranslated ? "t on" : "t";
      var busy = showTranslated && (inflight > 0 || queue.length > 0);
      ui.st.className = "st" + (lastErr ? " err" : busy ? " busy" : "");
      ui.st.title = lastErr || "";
      ui.tx.textContent = lastErr ? lastErr
        : !showTranslated ? T("original", "Bản gốc")
        : busy ? T("translating", "Đang dịch…")
        : T("translated", "Đã dịch");
      var pct = total ? Math.min(100, (done / total) * 100) : 0;
      ui.pg.style.width = (busy ? Math.max(pct, 8) : 100) + "%";
      ui.pg.style.opacity = busy ? "1" : "0";
    });
  }

  /* ── Khởi động: theo dõi ngay khi có <html>; quét body khi có; DOMContentLoaded → cho phép gỡ veil ── */
  var domReady = false, readyAt = 0;
  function boot() {
    if (!document.documentElement) { setTimeout(boot, 0); return; }
    veil();
    observe();
    var waitBody = function () {
      if (!document.body) { setTimeout(waitBody, 10); return; }
      buildBar();
      scan(document.body);
      schedule();
    };
    waitBody();
  }
  function onReady() {
    domReady = true;
    readyAt = Date.now();
    buildBar();
    if (!titleObs) watchTitle();
    // Phần đang thấy thường đã vào hàng; cho thêm tối đa 1.2s rồi hiện trang dù chưa xong.
    setTimeout(unveil, 1200);
    maybeUnveil();
    setInterval(function () {
      if (host && !host.isConnected && document.documentElement) document.documentElement.appendChild(host);
      textItems.forEach(function (_, n) { if (!n.isConnected) textItems.delete(n); });
    }, 5000);
  }
  boot();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", onReady);
  else onReady();
})();
