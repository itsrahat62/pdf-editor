"use strict";

const $ = (id) => document.getElementById(id);
const DPR = Math.min(window.devicePixelRatio || 1, 2);
const FLAG_ITALIC = 2, FLAG_SERIF = 4, FLAG_MONO = 8, FLAG_BOLD = 16;

const S = {
  state: null,        // server document state
  zoom: 1.25,         // CSS px per PDF point
  tool: "edit",
  edit: null,         // active editor box
  busy: Promise.resolve(),
  pageEls: [],
  pageVer: [],
  docId: 0,
  families: [],
  faces: {},
  bold: false, italic: false,
};

// ------------------------------------------------------------------ helpers
async function api(path, opts) {
  const r = await fetch(path, opts);
  let data = null;
  try { data = await r.json(); } catch (e) { /* not json */ }
  if (!r.ok) throw new Error((data && data.error) || ("Request failed (" + r.status + ")"));
  return data;
}
const post = (path, body) => api(path, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}),
});

function toast(msg, kind, ms) {
  const t = document.createElement("div");
  t.className = "toast " + (kind || "");
  t.textContent = msg;
  $("toasts").appendChild(t);
  setTimeout(() => t.remove(), ms || 4500);
}

function busy(on, text) {
  $("busyText").textContent = text || "Working…";
  $("busy").classList.toggle("hidden", !on);
}

/** Modal dialog. Resolves to the typed text (input), true (confirm) or null (cancel). */
function dialog(o) {
  return new Promise((resolve) => {
    const m = $("modal"), inp = $("modalInput"), ok = $("modalOk");
    $("modalTitle").textContent = o.title || "";
    $("modalMsg").textContent = o.message || "";
    inp.classList.toggle("hidden", !o.input);
    inp.value = "";
    ok.textContent = o.ok || "OK";
    ok.classList.toggle("danger", !!o.danger);
    ok.classList.toggle("primary", !o.danger);
    m.classList.remove("hidden");
    (o.input ? inp : ok).focus();
    const done = (v) => {
      m.classList.add("hidden");
      m.removeEventListener("keydown", key, true);
      ok.onclick = $("modalCancel").onclick = null;
      resolve(v);
    };
    const key = (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") { ev.preventDefault(); done(o.input ? inp.value : true); }
      else if (ev.key === "Escape") { ev.preventDefault(); done(null); }
    };
    m.addEventListener("keydown", key, true);
    ok.onclick = () => done(o.input ? inp.value : true);
    $("modalCancel").onclick = () => done(null);
  });
}

const hex = (c) => "#" + (c >>> 0).toString(16).padStart(6, "0").slice(-6);
const unhex = (h) => parseInt(h.replace("#", ""), 16) || 0;

function genericFamily(flags) {
  if (flags & FLAG_MONO) return '"Courier New", monospace';
  if (flags & FLAG_SERIF) return '"Times New Roman", serif';
  return "Arial, sans-serif";
}

function loadFace(key, url) {
  if (!S.faces[key]) {
    S.faces[key] = (async () => {
      try {
        const ff = new FontFace(key, "url(" + url + ")");
        await ff.load();
        document.fonts.add(ff);
        return key;
      } catch (e) { return null; }
    })();
  }
  return S.faces[key];
}

function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// ----------------------------------------------------------------- document
async function openFile(file, password) {
  if (!file) return;
  await finishEdit();
  const fd = new FormData();
  fd.append("file", file);
  if (password) fd.append("password", password);
  busy(true, "Opening " + file.name + "…");
  try {
    const st = await api("/api/open", { method: "POST", body: fd });
    busy(false);
    setDocument(st);
  } catch (e) {
    busy(false);
    if (e.message === "PASSWORD_REQUIRED" || e.message === "PASSWORD_WRONG") {
      const pw = await dialog({
        title: "Password required",
        message: e.message === "PASSWORD_WRONG" ? "That password is not correct. Please try again."
          : "“" + file.name + "” is protected. Enter its password to open it.",
        input: true, ok: "Open",
      });
      if (pw) return openFile(file, pw);
    } else {
      toast(e.message, "err");
    }
  }
}

function setDocument(st) {
  S.state = st;
  S.docId++;
  S.pageVer = st.pages.map(() => st.boot + "." + st.version);
  document.title = st.name + " — PDF Editor";
  $("docName").textContent = st.name;
  $("empty").classList.add("hidden");
  $("thumbs").classList.remove("hidden");
  const fit = fitZoom();
  S.zoom = Math.min(fit, 1.5);
  buildPages();
  syncButtons();
  $("main").scrollTop = 0;
}

function applyState(st, changedPage) {
  const structural = !S.state || st.pages.length !== S.state.pages.length ||
    st.pages.some((p, i) => Math.abs(p.w - S.state.pages[i].w) > 0.01 || Math.abs(p.h - S.state.pages[i].h) > 0.01);
  S.state = st;
  if (structural || changedPage === undefined) {
    const top = $("main").scrollTop;
    S.pageVer = st.pages.map(() => st.boot + "." + st.version);
    buildPages();
    $("main").scrollTop = top;
  } else {
    S.pageVer[changedPage] = st.boot + "." + st.version;
    loadPage(changedPage);
    refreshThumb(changedPage);
  }
  syncButtons();
}

function syncButtons() {
  const open = !!(S.state && S.state.open);
  $("btnSave").disabled = !open;
  $("btnUndo").disabled = !open || !S.state.can_undo;
  $("btnRedo").disabled = !open || !S.state.can_redo;
  $("zoomLabel").textContent = Math.round(S.zoom * 100) + "%";
}

function fitZoom() {
  if (!S.state || !S.state.open) return 1.25;
  const w = Math.max(...S.state.pages.map((p) => p.w));
  return Math.max(0.3, Math.min(4, ($("main").clientWidth - 60) / w));
}

// -------------------------------------------------------------------- pages
let observer = null;

function buildPages() {
  const wrap = $("pages");
  wrap.innerHTML = "";
  S.pageEls = [];
  if (observer) observer.disconnect();
  observer = new IntersectionObserver((entries) => {
    for (const en of entries) {
      en.target._visible = en.isIntersecting;
      if (en.isIntersecting) loadPage(en.target._index);
    }
    updateCurrentPage();
  }, { root: $("main"), rootMargin: "500px 0px" });

  S.state.pages.forEach((p, i) => {
    const el = document.createElement("div");
    el.className = "page";
    el._index = i;
    el.style.width = p.w * S.zoom + "px";
    el.style.height = p.h * S.zoom + "px";
    const img = document.createElement("img");
    img.alt = "";
    img.draggable = false;
    const layer = document.createElement("div");
    layer.className = "layer";
    el.append(img, layer);
    el._img = img; el._layer = layer; el._lines = null; el._key = null;
    wireLayer(el);
    wrap.appendChild(el);
    S.pageEls.push(el);
    observer.observe(el);
  });
  buildThumbs();
}

function pageKey(i) { return S.docId + ":" + S.pageVer[i] + ":" + S.zoom; }

function loadPage(i) {
  const el = S.pageEls[i];
  if (!el) return Promise.resolve();
  const key = pageKey(i);
  if (el._key === key) return el._loading || Promise.resolve();
  el._key = key;
  const url = "/api/page/" + i + ".png?scale=" + (S.zoom * DPR).toFixed(3) + "&v=" + encodeURIComponent(key);
  const pImg = new Promise((res) => {
    const pre = new Image();
    pre.onload = pre.onerror = () => { if (el._key === key) el._img.src = url; res(); };
    pre.src = url;
  });
  const pLines = api("/api/page/" + i + "/lines").then((d) => {
    if (el._key !== key) return;
    el._lines = d.lines; el._fonts = d.fonts;
    drawLayer(el);
  }).catch(() => {});
  el._loading = Promise.all([pImg, pLines]);
  return el._loading;
}

function drawLayer(el) {
  const z = S.zoom, layer = el._layer;
  layer.querySelectorAll(".line, .note").forEach((n) => n.remove());
  (el._lines || []).forEach((ln) => {
    const d = document.createElement("div");
    d.className = "line";
    d.style.left = ln.bbox[0] * z - 1 + "px";
    d.style.top = ln.bbox[1] * z + "px";
    d.style.width = (ln.bbox[2] - ln.bbox[0]) * z + 2 + "px";
    d.style.height = (ln.bbox[3] - ln.bbox[1]) * z + "px";
    d._line = ln;
    layer.appendChild(d);
  });
  if (el._lines && !el._lines.length) {
    const n = document.createElement("div");
    n.className = "note";
    n.innerHTML = "<span>No editable text on this page (scanned image?) — use Add text / Erase</span>";
    layer.appendChild(n);
  }
}

function updateCurrentPage() {
  const main = $("main"), mid = main.scrollTop + main.clientHeight / 3;
  let cur = 0;
  S.pageEls.forEach((el, i) => { if (el.offsetTop <= mid) cur = i; });
  S.cur = cur;
  if (S.state && S.state.open) $("pageLabel").textContent = "Page " + (cur + 1) + " / " + S.state.pages.length;
  document.querySelectorAll(".thumb").forEach((t, i) => t.classList.toggle("current", i === cur));
}

// --------------------------------------------------------------- thumbnails
function thumbUrl(i) {
  return "/api/page/" + i + ".png?scale=" + (110 * DPR / S.state.pages[i].w).toFixed(4) + "&v=" + S.docId + ":" + S.pageVer[i];
}

function buildThumbs() {
  const box = $("thumbs");
  box.innerHTML = "";
  S.state.pages.forEach((p, i) => {
    const t = document.createElement("div");
    t.className = "thumb";
    const img = document.createElement("img");
    img.loading = "lazy";
    img.style.height = 110 * p.h / p.w + "px";
    img.src = thumbUrl(i);
    const acts = document.createElement("div");
    acts.className = "acts";
    const rot = document.createElement("button");
    rot.innerHTML = '<svg><use href="#i-rotate"/></svg>'; rot.title = "Rotate page";
    rot.onclick = (e) => { e.stopPropagation(); pageAction(i, "rotate"); };
    const del = document.createElement("button");
    del.className = "del";
    del.innerHTML = '<svg><use href="#i-trash"/></svg>'; del.title = "Delete page";
    del.onclick = async (e) => {
      e.stopPropagation();
      const yes = await dialog({
        title: "Delete page " + (i + 1) + "?", message: "You can bring it back with Undo.",
        ok: "Delete", danger: true,
      });
      if (yes) pageAction(i, "delete");
    };
    acts.append(rot, del);
    const label = document.createElement("div");
    label.textContent = i + 1;
    t.append(img, acts, label);
    t.onclick = () => { $("main").scrollTop = S.pageEls[i].offsetTop - 12; };
    box.appendChild(t);
  });
  updateCurrentPage();
}

function refreshThumb(i) {
  const t = $("thumbs").children[i];
  if (t) t.querySelector("img").src = thumbUrl(i);
}

async function pageAction(i, what) {
  await finishEdit();
  try {
    const r = await post("/api/page/" + i + "/" + what);
    applyState(r.state);
  } catch (e) { toast(e.message, "err"); }
}

// ------------------------------------------------------------ colour sample
function sampleColor(el, xPt, yPt) {
  try {
    const img = el._img;
    if (!img.naturalWidth) return 0xffffff;
    const k = img.naturalWidth / S.state.pages[el._index].w;
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    const g = c.getContext("2d");
    const x = Math.max(0, Math.min(img.naturalWidth - 1, Math.round(xPt * k)));
    const y = Math.max(0, Math.min(img.naturalHeight - 1, Math.round(yPt * k)));
    g.drawImage(img, x, y, 1, 1, 0, 0, 1, 1);
    const d = g.getImageData(0, 0, 1, 1).data;
    return (d[0] << 16) | (d[1] << 8) | d[2];
  } catch (e) { return 0xffffff; }
}

// ------------------------------------------------------------------ editing
function wireLayer(el) {
  const layer = el._layer;
  layer.addEventListener("click", (ev) => {
    if (S.suppressClick) { S.suppressClick = false; return; }
    if (ev.target.closest(".editor")) return;
    if (S.tool === "edit") {
      const ln = ev.target._line;
      if (ln) startEdit(el, ln);
    } else if (S.tool === "add") {
      const r = layer.getBoundingClientRect();
      startAdd(el, (ev.clientX - r.left) / S.zoom, (ev.clientY - r.top) / S.zoom);
    }
  });
  layer.addEventListener("mousedown", (ev) => {
    if (S.tool !== "erase" || ev.button !== 0) return;
    ev.preventDefault();
    const r = layer.getBoundingClientRect();
    const x0 = ev.clientX - r.left, y0 = ev.clientY - r.top;
    const rb = document.createElement("div");
    rb.className = "rubber";
    layer.appendChild(rb);
    let box = null;
    const move = (e) => {
      const x1 = Math.max(0, Math.min(r.width, e.clientX - r.left));
      const y1 = Math.max(0, Math.min(r.height, e.clientY - r.top));
      box = [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
      rb.style.left = box[0] + "px"; rb.style.top = box[1] + "px";
      rb.style.width = box[2] - box[0] + "px"; rb.style.height = box[3] - box[1] + "px";
    };
    const up = async () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (!box || box[2] - box[0] < 3 || box[3] - box[1] < 3) { rb.remove(); return; }
      const rect = box.map((v) => v / S.zoom);
      const color = sampleColor(el, rect[0] - 2, rect[1] - 2);
      try {
        const res = await post("/api/page/" + el._index + "/erase", { rect, color });
        S.state = res.state;
        S.pageVer[el._index] = res.state.boot + "." + res.state.version;
        await loadPage(el._index);
        refreshThumb(el._index);
        syncButtons();
      } catch (e) { toast(e.message, "err"); }
      rb.remove();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
}

function makeEditor(el) {
  const ed = document.createElement("div");
  ed.className = "editor";
  ed.contentEditable = "true";
  ed.spellcheck = false;
  ed.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !(ev.shiftKey && S.edit && S.edit.mode === "add")) {
      ev.preventDefault();
      finishEdit();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      cancelEdit();
    }
    ev.stopPropagation();
  });
  ed.addEventListener("paste", (ev) => {
    ev.preventDefault();
    let t = (ev.clipboardData || window.clipboardData).getData("text") || "";
    if (!(S.edit && S.edit.mode === "add")) t = t.replace(/\s*\n\s*/g, " ");
    document.execCommand("insertText", false, t);
  });
  ed.addEventListener("drop", (ev) => ev.preventDefault());
  el._layer.appendChild(ed);
  return ed;
}

function focusEnd(ed, ev) {
  ed.focus();
  const sel = window.getSelection();
  sel.selectAllChildren(ed);
  sel.collapseToEnd();
}

async function startEdit(el, line) {
  await finishEdit();
  if (S.tool !== "edit") return;
  const z = S.zoom, b = line.bbox;
  const straight = Math.abs(line.dir[0] - 1) < 1e-3 && Math.abs(line.dir[1]) < 1e-3;
  const ed = makeEditor(el);
  const h = straight ? (b[3] - b[1]) : line.spans[0].size * 1.3;
  ed.style.left = b[0] * z - 2 + "px";
  ed.style.top = b[1] * z + "px";
  ed.style.padding = "0 2px";
  ed.style.height = h * z + "px";
  ed.style.lineHeight = h * z + "px";
  ed.style.minWidth = (straight ? (b[2] - b[0]) : 40) * z + 4 + "px";
  ed.style.background = hex(sampleColor(el, b[0] - 1.5, b[1] - 1.5));
  line.spans.forEach((sp, i) => {
    const s = document.createElement("span");
    s.dataset.i = i;
    s.textContent = sp.text;
    ed.appendChild(s);
  });
  S.edit = { mode: "line", el, line, ed, ov: {} };
  const sp0 = line.spans[0];
  $("font").value = "";
  $("font").placeholder = sp0.name || "Font";
  $("size").value = +sp0.size.toFixed(2);
  $("color").value = hex(sp0.color);
  setToggle("bold", !!(sp0.flags & FLAG_BOLD));
  setToggle("italic", !!(sp0.flags & FLAG_ITALIC));
  showFontBar();
  stylePreview();
  focusEnd(ed);
}

async function startAdd(el, x, y) {
  await finishEdit();
  if (S.tool !== "add") return;
  const z = S.zoom;
  const size = parseFloat($("size").value) || 12;
  const ed = makeEditor(el);
  ed.style.left = x * z + "px";
  ed.style.top = (y - size * 0.6) * z + "px";
  ed.style.lineHeight = "1.2";
  ed.style.minWidth = size * z + "px";
  ed.style.minHeight = size * 1.2 * z + "px";
  ed.style.background = hex(sampleColor(el, x, y));
  S.edit = { mode: "add", el, ed, x, y: y - size * 0.6, ov: {} };
  $("font").placeholder = "Arial";
  showFontBar();
  stylePreview();
  focusEnd(ed);
}

function currentStyle() {
  // toolbar values (used for Add text, and as overrides while editing a line)
  const fam = $("font").value.trim();
  return {
    family: S.families.find((f) => f.toLowerCase() === fam.toLowerCase()) || "",
    size: parseFloat($("size").value) || 12,
    color: unhex($("color").value),
    bold: S.bold, italic: S.italic,
  };
}

function setToggle(which, on) {
  S[which] = on;
  $(which === "bold" ? "btnBold" : "btnItalic").classList.toggle("active", on);
}

/** Style the text in the editor box so it previews the real result. */
function stylePreview() {
  const e = S.edit;
  if (!e) return;
  const z = S.zoom, st = currentStyle();
  if (e.mode === "add") {
    const ed = e.ed;
    ed.style.fontSize = st.size * z + "px";
    ed.style.color = hex(st.color);
    ed.style.fontFamily = (st.family ? '"' + st.family + '", ' : "") + "Arial, sans-serif";
    ed.style.fontWeight = st.bold ? "bold" : "normal";
    ed.style.fontStyle = st.italic ? "italic" : "normal";
    const key = "af" + hashStr(st.family + "|" + st.bold + "|" + st.italic);
    loadFace(key, "/api/fontface?family=" + encodeURIComponent(st.family || "Arial") +
      "&bold=" + (st.bold ? 1 : 0) + "&italic=" + (st.italic ? 1 : 0)).then((k) => {
      if (k && S.edit === e && key === "af" + hashStr(currentStyle().family + "|" + S.bold + "|" + S.italic)) {
        ed.style.fontFamily = k + ", Arial, sans-serif";
        ed.style.fontWeight = "normal"; ed.style.fontStyle = "normal";
      }
    });
    return;
  }
  const ov = e.ov;
  e.ed.querySelectorAll("span[data-i]").forEach((s) => {
    const sp = e.line.spans[+s.dataset.i];
    if (!sp) return;
    const bold = ov.bold !== undefined ? ov.bold : !!(sp.flags & FLAG_BOLD);
    const italic = ov.italic !== undefined ? ov.italic : !!(sp.flags & FLAG_ITALIC);
    s.style.fontSize = (ov.size || sp.size) * z + "px";
    s.style.color = hex(ov.color !== undefined ? ov.color : sp.color);
    s.style.fontFamily = (ov.family ? '"' + ov.family + '", ' : "") + genericFamily(sp.flags);
    s.style.fontWeight = bold ? "bold" : "normal";
    s.style.fontStyle = italic ? "italic" : "normal";
    let q = "page=" + e.el._index + "&font=" + encodeURIComponent(sp.font) + "&flags=" + sp.flags;
    if (ov.family) q += "&family=" + encodeURIComponent(ov.family);
    if (ov.bold !== undefined) q += "&bold=" + (ov.bold ? 1 : 0);
    if (ov.italic !== undefined) q += "&italic=" + (ov.italic ? 1 : 0);
    const key = "pf" + hashStr(S.docId + "|" + q);
    s.dataset.face = key;
    loadFace(key, "/api/fontface?" + q).then((k) => {
      if (k && s.dataset.face === key) {
        s.style.fontFamily = k + ", " + genericFamily(sp.flags);
        s.style.fontWeight = "normal"; s.style.fontStyle = "normal";
      }
    });
  });
}

function showFontBar() {
  const bar = $("fontbar"), e = S.edit;
  if (!e) { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  bar.innerHTML = "";
  if (e.mode === "line") {
    const seen = new Set();
    e.line.spans.forEach((sp) => {
      const key = sp.font + "|" + sp.flags;
      if (seen.has(key)) return;
      seen.add(key);
      const fi = (e.el._fonts || {})[key] || { label: sp.name, kind: "system" };
      let cls = "ok", txt = "✓ Same font";
      if (e.ov.family) { cls = "warn"; txt = "Changed to " + e.ov.family; }
      else if (fi.kind === "similar") { cls = "warn"; txt = "Not installed — similar font: " + fi.label; }
      else if (fi.kind === "substitute") { cls = "bad"; txt = "Not on this PC — using " + fi.label; }
      else if (fi.kind === "embedded") txt = "✓ Same font (from the PDF)";
      const item = document.createElement("span");
      const name = document.createElement("b");
      name.textContent = sp.name + " · " + (+sp.size.toFixed(1)) + " pt";
      const chip = document.createElement("span");
      chip.className = "chip " + cls;
      chip.textContent = txt;
      item.append(name, chip);
      bar.appendChild(item);
    });
  } else {
    const item = document.createElement("span");
    item.textContent = "New text — choose the font, size and colour in the toolbar";
    bar.appendChild(item);
  }
  const keys = document.createElement("span");
  keys.className = "keys";
  keys.innerHTML = "<kbd>Enter</kbd> apply &nbsp; <kbd>Esc</kbd> cancel" +
    (e.mode === "add" ? " &nbsp; <kbd>Shift</kbd>+<kbd>Enter</kbd> new line" : "");
  bar.appendChild(keys);
}

function collectSegs(ed) {
  const segs = [];
  let last = 0;
  ed.childNodes.forEach((n) => {
    let i = last, t = "";
    if (n.nodeType === 3) t = n.nodeValue;
    else if (n.nodeType === 1) {
      if (n.dataset && n.dataset.i !== undefined) i = +n.dataset.i;
      t = n.textContent;
    }
    t = t.replace(/[\r\n]+/g, " ").replace(/ /g, " ");
    last = i;
    if (!t) return;
    if (segs.length && segs[segs.length - 1].src === i) segs[segs.length - 1].text += t;
    else segs.push({ src: i, text: t });
  });
  return segs;
}

function cancelEdit() {
  const e = S.edit;
  if (!e) return;
  S.edit = null;
  e.ed.remove();
  showFontBar();
}

/** Apply the active edit (if any). Returns a promise that settles when done. */
function finishEdit() {
  const e = S.edit;
  if (!e) return S.busy;
  S.edit = null;
  showFontBar();
  S.busy = S.busy.then(() => commit(e)).catch((err) => toast(err.message, "err"));
  return S.busy;
}

async function commit(e) {
  const pno = e.el._index;
  let res;
  e.ed.contentEditable = "false";
  e.ed.classList.add("pending");
  try {
    if (e.mode === "add") {
      const text = e.ed.innerText.replace(/ /g, " ").replace(/\n+$/, "");
      if (!text.trim()) { e.ed.remove(); return; }
      const st = currentStyle();
      res = await post("/api/page/" + pno + "/add_text", {
        x: e.x, y: e.y, text, family: st.family || "Arial", bold: st.bold, italic: st.italic,
        size: st.size, color: st.color,
      });
    } else {
      const segs = collectSegs(e.ed);
      const same = !Object.keys(e.ov).length && e.line.spans.every((sp, i) => {
        const sg = segs.filter((s) => s.src === i).map((s) => s.text).join("");
        return sg === sp.text;
      });
      if (same) { e.ed.remove(); return; }
      res = await post("/api/page/" + pno + "/edit", { line: e.line, segs, ov: e.ov });
    }
    S.state = res.state;
    S.pageVer[pno] = res.state.boot + "." + res.state.version;
    await loadPage(pno);
    refreshThumb(pno);
    syncButtons();
    reportFonts(res.result);
  } finally {
    e.ed.remove();
  }
}

function reportFonts(result) {
  if (!result || !result.changed) return;
  const bad = (result.fonts || []).filter((f) => f.kind === "substitute" || f.kind === "similar");
  if (bad.length) {
    toast("Original font is not available on this PC — used " + bad.map((f) => f.label).join(", ") +
      ". Install the font (or add it with “+ Font”) for an exact match.", "warn", 7000);
  }
}

// ------------------------------------------------------------------ toolbar
function setTool(t) {
  finishEdit();
  S.tool = t;
  document.body.className = document.body.className.replace(/\btool-\w+/g, "").trim() + " tool-" + t;
  document.querySelectorAll(".tool").forEach((b) => b.classList.toggle("active", b.dataset.tool === t));
}

function styleChanged(prop) {
  const e = S.edit;
  if (e && e.mode === "line") {
    const st = currentStyle();
    if (prop === "family") { if (st.family) e.ov.family = st.family; else delete e.ov.family; }
    else e.ov[prop] = st[prop];
    showFontBar();
  }
  stylePreview();
  if (e) e.ed.focus();
}

async function setZoom(z) {
  await finishEdit();
  if (!S.state || !S.state.open) return;
  const main = $("main");
  const ratio = main.scrollHeight ? main.scrollTop / main.scrollHeight : 0;
  S.zoom = Math.max(0.3, Math.min(4, z));
  S.pageEls.forEach((el, i) => {
    el.style.width = S.state.pages[i].w * S.zoom + "px";
    el.style.height = S.state.pages[i].h * S.zoom + "px";
    drawLayer(el);
    if (el._visible) loadPage(i);
  });
  main.scrollTop = ratio * main.scrollHeight;
  syncButtons();
}

async function save() {
  await finishEdit();
  if (!S.state || !S.state.open) return;
  if (window.pywebview && window.pywebview.api && window.pywebview.api.save) {
    busy(true, "Saving…");
    try {
      const r = await window.pywebview.api.save();
      busy(false);
      if (r && r.saved) toast("Saved: " + r.path, "ok", 6000);
      else if (r && r.error) toast("Could not save: " + r.error, "err");
    } catch (e) { busy(false); toast(String(e), "err"); }
  } else {
    const a = document.createElement("a");
    a.href = "/api/download";
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast("Downloading the edited PDF…", "ok");
  }
}

async function undoRedo(what) {
  await finishEdit();
  if (!S.state || !S.state.open) return;
  try {
    const r = await post("/api/" + what);
    applyState(r.state);
  } catch (e) { toast(e.message, "err"); }
}

async function loadFonts() {
  try {
    const d = await api("/api/fonts");
    S.families = d.families;
    $("fontlist").innerHTML = "";
    const frag = document.createDocumentFragment();
    d.families.forEach((f) => {
      const o = document.createElement("option");
      o.value = f;
      frag.appendChild(o);
    });
    $("fontlist").appendChild(frag);
  } catch (e) { /* ignore */ }
}

function init() {
  document.body.classList.add("tool-edit");
  $("btnOpen").onclick = $("btnOpen2").onclick = () => $("file").click();
  $("file").onchange = (ev) => { openFile(ev.target.files[0]); ev.target.value = ""; };
  $("btnSave").onclick = save;
  $("btnUndo").onclick = () => undoRedo("undo");
  $("btnRedo").onclick = () => undoRedo("redo");
  document.querySelectorAll(".tool").forEach((b) => { b.onclick = () => setTool(b.dataset.tool); });
  $("btnZoomIn").onclick = () => setZoom(S.zoom * 1.2);
  $("btnZoomOut").onclick = () => setZoom(S.zoom / 1.2);
  $("btnFit").onclick = () => setZoom(fitZoom());
  $("btnBold").onclick = () => { setToggle("bold", !S.bold); styleChanged("bold"); };
  $("btnItalic").onclick = () => { setToggle("italic", !S.italic); styleChanged("italic"); };
  $("font").addEventListener("change", () => styleChanged("family"));
  $("font").addEventListener("focus", () => $("font").select());
  $("size").addEventListener("input", () => styleChanged("size"));
  $("color").addEventListener("input", () => styleChanged("color"));
  $("font").addEventListener("keydown", (ev) => { if (ev.key === "Enter") { styleChanged("family"); } ev.stopPropagation(); });
  $("size").addEventListener("keydown", (ev) => ev.stopPropagation());
  $("btnAddFont").onclick = () => $("fontfile").click();
  $("fontfile").onchange = async (ev) => {
    const fd = new FormData();
    for (const f of ev.target.files) fd.append("file", f);
    ev.target.value = "";
    try {
      const r = await api("/api/fonts/add", { method: "POST", body: fd });
      await loadFonts();
      toast("Font added: " + r.added.join(", "), "ok");
      S.pageEls.forEach((el, i) => { if (el._visible) { el._key = null; loadPage(i); } });
    } catch (e) { toast(e.message, "err"); }
  };

  // keep toolbar buttons from stealing focus from the text box
  $("toolbar").addEventListener("mousedown", (ev) => {
    if (ev.target.closest("button")) ev.preventDefault();
  });
  // clicking outside the text box applies the edit
  document.addEventListener("mousedown", (ev) => {
    if (!S.edit) return;
    if (ev.target.closest(".editor, #toolbar, #fontbar, .statusbar, .overlay")) return;
    if (ev.target.closest(".layer") && S.tool === "add") S.suppressClick = true;
    finishEdit();
  }, true);

  $("main").addEventListener("scroll", updateCurrentPage, { passive: true });
  window.addEventListener("keydown", (ev) => {
    const k = ev.key.toLowerCase();
    if (ev.ctrlKey && k === "o") { ev.preventDefault(); $("file").click(); }
    else if (ev.ctrlKey && k === "s") { ev.preventDefault(); save(); }
    else if (ev.ctrlKey && k === "z" && !ev.shiftKey) { ev.preventDefault(); undoRedo("undo"); }
    else if (ev.ctrlKey && (k === "y" || (k === "z" && ev.shiftKey))) { ev.preventDefault(); undoRedo("redo"); }
    else if (ev.ctrlKey && (k === "=" || k === "+")) { ev.preventDefault(); setZoom(S.zoom * 1.2); }
    else if (ev.ctrlKey && k === "-") { ev.preventDefault(); setZoom(S.zoom / 1.2); }
  });

  // drag & drop a PDF anywhere
  let depth = 0;
  window.addEventListener("dragenter", (ev) => { ev.preventDefault(); depth++; document.body.classList.add("dragging"); });
  window.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; document.body.classList.remove("dragging"); } });
  window.addEventListener("dragover", (ev) => ev.preventDefault());
  window.addEventListener("drop", (ev) => {
    ev.preventDefault();
    depth = 0;
    document.body.classList.remove("dragging");
    const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
    if (f) openFile(f);
  });

  loadFonts();
  api("/api/state").then((st) => { if (st.open) setDocument(st); }).catch(() => {});
}

init();
