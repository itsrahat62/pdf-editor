"use strict";

const $ = (id) => document.getElementById(id);
const DPR = Math.min(window.devicePixelRatio || 1, 2);
const FLAG_ITALIC = 2, FLAG_SERIF = 4, FLAG_MONO = 8, FLAG_BOLD = 16;
const RECT_TOOLS = new Set(["erase", "textbox", "image", "sign", "highlight", "underline", "strikeout", "rectangle", "ellipse"]);
const LINE_TOOLS = new Set(["line", "arrow"]);
const TOOL_COLORS = {
  highlight: "#ffd400", underline: "#2f6bff", strikeout: "#d43a2f", note: "#ffd400", drawing: "#d43a2f",
  rectangle: "#d43a2f", ellipse: "#d43a2f", line: "#d43a2f", arrow: "#d43a2f",
};
const TAB_DEFAULT_TOOL = { edit: "edit", comment: "highlight", pages: "edit", tools: "edit" };

const S = {
  state: null,        // server document state
  zoom: 1.25,         // CSS px per PDF point
  tab: "edit",
  tool: "edit",
  edit: null,         // active text editor box
  busy: Promise.resolve(),
  pageEls: [],
  pageVer: [],
  docId: 0,
  families: [],
  faces: {},
  bold: false, italic: false,
  sel: new Set(),     // selected pages (thumbnails)
  cur: 0,
  placing: null,      // image / signature waiting to be placed
  protectPw: "",
  selAnnot: null,
};

// ================================================================== helpers
/** Page size in whole screen pixels, so the page image is shown 1:1 (sharp). */
function pageBox(i) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const p = S.state.pages[i];
  const W = Math.max(8, Math.round(p.w * S.zoom * dpr));
  const H = Math.max(8, Math.round(p.h * S.zoom * dpr));
  return { W, H, cssW: W / dpr, cssH: H / dpr };
}

function sizePage(pg) {
  const b = pageBox(pg._index);
  pg.style.width = b.cssW + "px";
  pg.style.height = b.cssH + "px";
}

/** Keep every page on the screen's pixel grid; a half-pixel offset blurs the image. */
function snapPages() {
  const dpr = window.devicePixelRatio || 1;
  for (const pg of S.pageEls) {
    pg.style.transform = "";
    const r = pg.getBoundingClientRect();
    const fx = ((r.left * dpr) % 1 + 1) % 1, fy = ((r.top * dpr) % 1 + 1) % 1;
    if (fx > 0.01 || fy > 0.01) pg.style.transform = "translate(" + (-fx / dpr) + "px," + (-fy / dpr) + "px)";
  }
}

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
const postForm = (path, fd) => api(path, { method: "POST", body: fd });

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

async function run(label, fn) {
  busy(true, label);
  try { return await fn(); } catch (e) { toast(e.message, "err", 6000); return null; } finally { busy(false); }
}

const hex = (c) => "#" + (c >>> 0).toString(16).padStart(6, "0").slice(-6);
const unhex = (h) => parseInt(String(h).replace("#", ""), 16) || 0;
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };

function genericFamily(flags) {
  if (flags & FLAG_MONO) return '"Courier New", monospace';
  if (flags & FLAG_SERIF) return '"Times New Roman", "Nirmala UI", serif';
  return 'Arial, "Nirmala UI", sans-serif';
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

function pickFile(accept, multiple) {
  return new Promise((resolve) => {
    const inp = $("anyfile");
    inp.accept = accept || "";
    inp.multiple = !!multiple;
    inp.value = "";
    inp.onchange = () => resolve(Array.from(inp.files || []));
    inp.click();
  });
}

// ================================================================== dialogs
/** Modal dialog. o: {title, message, body (Node), ok, cancel, danger, wide, onOk(): value|false}. */
function dialog(o) {
  return new Promise((resolve) => {
    const m = $("modal"), ok = $("modalOk"), cancel = $("modalCancel"), body = $("modalBody");
    $("modalTitle").textContent = o.title || "";
    $("modalMsg").textContent = o.message || "";
    body.innerHTML = "";
    if (o.body) body.appendChild(o.body);
    m.querySelector(".dialog").classList.toggle("wide", !!o.wide);
    ok.textContent = o.ok || "OK";
    ok.classList.toggle("hidden", o.ok === false);
    cancel.textContent = o.cancel || "Cancel";
    ok.classList.toggle("danger", !!o.danger);
    ok.classList.toggle("primary", !o.danger);
    m.classList.remove("hidden");
    const first = body.querySelector("input:not([type=color]):not([type=checkbox]):not([type=range]), textarea, select");
    setTimeout(() => (first || ok).focus(), 20);
    const done = (v) => {
      m.classList.add("hidden");
      m.removeEventListener("keydown", key, true);
      ok.onclick = cancel.onclick = null;
      resolve(v);
    };
    const accept = () => {
      const v = o.onOk ? o.onOk() : true;
      if (v !== false) done(v);
    };
    const key = (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); done(null); }
      else if (ev.key === "Enter" && ev.target.tagName !== "TEXTAREA" && !ev.defaultPrevented) {
        ev.preventDefault(); ev.stopPropagation(); accept();
      }
    };
    m.addEventListener("keydown", key, true);
    ok.onclick = accept;
    cancel.onclick = () => done(null);
  });
}

/** Form dialog: fields [{name, label, type, value, options, min, max, step, placeholder, rows}]. */
async function formDialog(o) {
  const form = el("div", "form");
  const inputs = {};
  for (const f of o.fields) {
    if (f.type === "note") { const n = el("div", "full", f.label); n.style.color = "var(--muted)"; form.appendChild(n); continue; }
    const lab = el("label", null, f.label || "");
    let inp;
    if (f.type === "select") {
      inp = el("select", "field");
      for (const opt of f.options) {
        const op = el("option", null, Array.isArray(opt) ? opt[1] : opt);
        op.value = Array.isArray(opt) ? opt[0] : opt;
        inp.appendChild(op);
      }
      inp.value = f.value;
    } else if (f.type === "textarea") {
      inp = el("textarea", "field");
      inp.rows = f.rows || 3;
      inp.value = f.value || "";
    } else if (f.type === "color") {
      const sw = el("label", "swatch");
      inp = el("input");
      inp.type = "color";
      inp.value = f.value || "#000000";
      sw.appendChild(inp);
      form.append(lab, sw);
      inputs[f.name] = inp;
      continue;
    } else if (f.type === "font") {
      inp = el("input", "field");
      inp.setAttribute("list", "fontlist");
      inp.dataset.latin = "";
      inp.value = f.value || "";
      inp.placeholder = "Default";
    } else {
      inp = el("input", "field");
      inp.type = f.type || "text";
      if (f.type === "password") inp.dataset.latin = "";
      inp.value = f.value === undefined ? "" : f.value;
      for (const k of ["min", "max", "step", "placeholder"]) if (f[k] !== undefined) inp[k] = f[k];
    }
    if (f.full) { inp.classList.add("full"); form.append(inp); } else form.append(lab, inp);
    inputs[f.name] = inp;
  }
  if (o.extra) form.appendChild(o.extra);
  return dialog({
    title: o.title, message: o.message, body: form, ok: o.ok || "Apply", wide: o.wide,
    onOk: () => {
      const v = {};
      for (const [k, inp] of Object.entries(inputs)) v[k] = inp.type === "checkbox" ? inp.checked : inp.value;
      if (o.validate) { const err = o.validate(v); if (err) { toast(err, "warn"); return false; } }
      return v;
    },
  });
}

// ================================================================ document
async function openFiles(files, password) {
  if (!files || !files.length) return;
  await finishEdit();
  const fd = new FormData();
  for (const f of files) fd.append("file", f);
  if (password) fd.append("password", password);
  busy(true, "Opening " + files[0].name + "…");
  try {
    const st = await postForm("/api/open", fd);
    busy(false);
    setDocument(st);
  } catch (e) {
    busy(false);
    if (e.message === "PASSWORD_REQUIRED" || e.message === "PASSWORD_WRONG") {
      const v = await formDialog({
        title: "Password required",
        message: e.message === "PASSWORD_WRONG" ? "That password is not correct. Please try again."
          : "“" + files[0].name + "” is protected. Enter its password to open it.",
        fields: [{ name: "pw", label: "Password", type: "password" }], ok: "Open",
      });
      if (v && v.pw) return openFiles(files, v.pw);
    } else {
      toast(e.message, "err");
    }
  }
}

function setDocument(st) {
  S.state = st;
  S.docId++;
  S.pageVer = st.pages.map(() => st.boot + "." + st.version);
  S.sel = new Set([0]);
  S.protectPw = "";
  $("protectLabel").textContent = "Password";
  document.title = st.name + " — PDF Editor";
  $("docName").textContent = st.name;
  $("empty").classList.add("hidden");
  $("thumbs").classList.remove("hidden");
  S.zoom = Math.min(fitZoom(), 1.5);
  S.dismissedFonts = new Set();
  checkMissingFonts();
  buildPages();
  syncButtons();
  $("main").scrollTop = 0;
}

function applyState(st, changedPage) {
  const structural = !S.state || st.pages.length !== S.state.pages.length ||
    st.pages.some((p, i) => Math.abs(p.w - S.state.pages[i].w) > 0.01 || Math.abs(p.h - S.state.pages[i].h) > 0.01);
  S.state = st;
  const ver = st.boot + "." + st.version;
  if (structural || changedPage === undefined) {
    const top = $("main").scrollTop;
    S.pageVer = st.pages.map(() => ver);
    S.sel = new Set([...S.sel].filter((p) => p < st.pages.length));
    if (!S.sel.size) S.sel.add(Math.min(S.cur, st.pages.length - 1));
    buildPages();
    $("main").scrollTop = top;
  } else {
    S.pageVer[changedPage] = ver;
    loadPage(changedPage);
    refreshThumb(changedPage);
  }
  syncButtons();
}

function syncButtons() {
  const open = !!(S.state && S.state.open);
  $("btnSave").disabled = !open;
  $("btnPrint").disabled = !open;
  $("btnUndo").disabled = !open || !S.state.can_undo;
  $("btnRedo").disabled = !open || !S.state.can_redo;
  $("zoomLabel").textContent = Math.round(S.zoom * 100) + "%";
}

function fitZoom() {
  if (!S.state || !S.state.open) return 1.25;
  const w = Math.max(...S.state.pages.map((p) => p.w));
  return Math.max(0.3, Math.min(4, ($("main").clientWidth - 60) / w));
}

function needDoc() {
  if (!S.state || !S.state.open) { toast("Open a PDF first.", "warn"); return false; }
  return true;
}

// =================================================================== pages
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
    const pg = el("div", "page");
    pg._index = i;
    sizePage(pg);
    const img = el("img");
    img.alt = "";
    img.draggable = false;
    const layer = el("div", "layer");
    pg.append(img, layer);
    pg._img = img; pg._layer = layer; pg._lines = null; pg._key = null;
    wireLayer(pg);
    wrap.appendChild(pg);
    S.pageEls.push(pg);
    observer.observe(pg);
  });
  buildThumbs();
  requestAnimationFrame(snapPages);
}

function pageKey(i) { return S.docId + ":" + S.pageVer[i] + ":" + S.zoom + ":" + (window.devicePixelRatio || 1); }

function loadPage(i, force) {
  const pg = S.pageEls[i];
  if (!pg) return Promise.resolve();
  const key = pageKey(i);
  if (pg._key === key && !force) return pg._loading || Promise.resolve();
  pg._key = key;
  const pb = pageBox(i);
  const url = "/api/page/" + i + ".png?w=" + pb.W + "&h=" + pb.H + "&v=" + encodeURIComponent(key);
  const pImg = new Promise((res) => {
    const pre = new Image();
    pre.onload = pre.onerror = () => { if (pg._key === key) pg._img.src = url; res(); };
    pre.src = url;
  });
  const pLines = api("/api/page/" + i + "/lines").then((d) => {
    if (pg._key !== key) return;
    pg._lines = d.lines; pg._fonts = d.fonts; pg._annots = d.annots || []; pg._widgets = d.widgets || [];
    drawLayer(pg);
  }).catch(() => {});
  pg._loading = Promise.all([pImg, pLines]);
  return pg._loading;
}

function box(div, b) {
  const z = S.zoom;
  div.style.left = b[0] * z + "px";
  div.style.top = b[1] * z + "px";
  div.style.width = Math.max(2, (b[2] - b[0]) * z) + "px";
  div.style.height = Math.max(2, (b[3] - b[1]) * z) + "px";
}

function drawLayer(pg) {
  const layer = pg._layer;
  layer.querySelectorAll(".line, .note, .annot, .widget").forEach((n) => n.remove());
  (pg._lines || []).forEach((ln) => {
    const d = el("div", "line");
    box(d, [ln.bbox[0] - 1, ln.bbox[1], ln.bbox[2] + 1, ln.bbox[3]]);
    d._line = ln;
    layer.appendChild(d);
  });
  (pg._annots || []).forEach((a) => {
    const d = el("div", "annot");
    box(d, a.rect);
    d.title = a.type + (a.content ? ": " + a.content : "");
    d._annot = a;
    const del = el("button", "del", "Delete");
    del.onclick = (ev) => { ev.stopPropagation(); deleteAnnot(pg, a); };
    d.appendChild(del);
    d.onclick = (ev) => { ev.stopPropagation(); selectAnnot(pg, a, d); };
    if (S.selAnnot && S.selAnnot.xref === a.xref && S.selAnnot.page === pg._index) d.classList.add("selected");
    layer.appendChild(d);
  });
  (pg._widgets || []).forEach((w) => layer.appendChild(widgetEl(pg, w)));
  if (pg._lines && !pg._lines.length && !(pg._widgets || []).length) {
    const n = el("div", "note");
    n.innerHTML = "<span>No editable text on this page (scanned image?) — use Add text / Erase</span>";
    layer.appendChild(n);
  }
}

function updateCurrentPage() {
  const main = $("main"), mid = main.scrollTop + main.clientHeight / 3;
  let cur = 0;
  S.pageEls.forEach((pg, i) => { if (pg.offsetTop <= mid) cur = i; });
  S.cur = cur;
  if (S.state && S.state.open) $("pageLabel").textContent = "Page " + (cur + 1) + " / " + S.state.pages.length;
  document.querySelectorAll(".thumb").forEach((t, i) => t.classList.toggle("current", i === cur));
}

function scrollToPage(i, yPt) {
  const pg = S.pageEls[i];
  if (!pg) return;
  $("main").scrollTop = pg.offsetTop - 12 + (yPt ? Math.max(0, yPt * S.zoom - 120) : 0);
}

// ============================================================== thumbnails
function thumbUrl(i) {
  return "/api/page/" + i + ".png?scale=" + (110 * DPR / S.state.pages[i].w).toFixed(4) + "&v=" + S.docId + ":" + S.pageVer[i];
}

function selectedPages() {
  const s = [...S.sel].filter((p) => p < S.state.pages.length).sort((a, b) => a - b);
  return s.length ? s : [S.cur];
}

function paintSelection() {
  document.querySelectorAll(".thumb").forEach((t, i) => t.classList.toggle("selected", S.sel.has(i)));
}

function buildThumbs() {
  const boxEl = $("thumbs");
  boxEl.innerHTML = "";
  S.state.pages.forEach((p, i) => {
    const t = el("div", "thumb");
    t.draggable = true;
    const img = el("img");
    img.loading = "lazy";
    img.style.height = 112 * p.h / p.w + "px";
    img.src = thumbUrl(i);
    const acts = el("div", "acts");
    const rot = el("button");
    rot.innerHTML = '<svg><use href="#i-rotate"/></svg>'; rot.title = "Rotate page";
    rot.onclick = (e) => { e.stopPropagation(); pageAction("rotate", { pages: [i], deg: 90 }); };
    const del = el("button", "del");
    del.innerHTML = '<svg><use href="#i-trash"/></svg>'; del.title = "Delete page";
    del.onclick = async (e) => {
      e.stopPropagation();
      if (await dialog({ title: "Delete page " + (i + 1) + "?", message: "You can bring it back with Undo.", ok: "Delete", danger: true })) {
        pageAction("delete", { pages: [i] });
      }
    };
    acts.append(rot, del);
    t.append(img, acts, el("div", null, String(i + 1)));
    t.onclick = (ev) => {
      if (ev.ctrlKey) { S.sel.has(i) ? S.sel.delete(i) : S.sel.add(i); }
      else if (ev.shiftKey && S.sel.size) {
        const a = Math.min(...S.sel), b = Math.max(...S.sel);
        const lo = Math.min(a, i), hi = Math.max(b, i);
        S.sel = new Set(); for (let k = lo; k <= hi; k++) S.sel.add(k);
      } else { S.sel = new Set([i]); scrollToPage(i); }
      paintSelection();
    };
    t.addEventListener("dragstart", (ev) => { ev.dataTransfer.setData("text/x-page", String(i)); ev.dataTransfer.effectAllowed = "move"; });
    t.addEventListener("dragover", (ev) => {
      if (!ev.dataTransfer.types.includes("text/x-page")) return;
      ev.preventDefault();
      const r = t.getBoundingClientRect(), after = ev.clientY > r.top + r.height / 2;
      t.classList.toggle("drop-after", after); t.classList.toggle("drop-before", !after);
    });
    t.addEventListener("dragleave", () => t.classList.remove("drop-after", "drop-before"));
    t.addEventListener("drop", (ev) => {
      const src = ev.dataTransfer.getData("text/x-page");
      if (src === "") return;
      ev.preventDefault(); ev.stopPropagation();
      const after = t.classList.contains("drop-after");
      t.classList.remove("drop-after", "drop-before");
      const s = +src, dst = after ? i + 1 : i;
      if (dst === s || dst === s + 1) return;
      S.sel = new Set([dst > s ? dst - 1 : dst]);
      pageAction("move", { src: s, dst });
    });
    boxEl.appendChild(t);
  });
  paintSelection();
  updateCurrentPage();
}

function refreshThumb(i) {
  const t = $("thumbs").children[i];
  if (t) t.querySelector("img").src = thumbUrl(i);
}

async function pageAction(what, body) {
  await finishEdit();
  if (!needDoc()) return;
  const r = await run("Updating pages…", () => post("/api/pages/" + what, body));
  if (r) applyState(r.state);
}

// =========================================================== colour sample
function sampleColor(pg, xPt, yPt) {
  try {
    const img = pg._img;
    if (!img.naturalWidth) return 0xffffff;
    const k = img.naturalWidth / S.state.pages[pg._index].w;
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

// ========================================================= page interaction
function ptOf(pg, ev) {
  const r = pg._layer.getBoundingClientRect();
  return [(ev.clientX - r.left) / S.zoom, (ev.clientY - r.top) / S.zoom];
}

function wireLayer(pg) {
  const layer = pg._layer;
  layer.addEventListener("click", (ev) => {
    if (S.suppressClick) { S.suppressClick = false; return; }
    if (ev.target.closest(".editor, .widget, .annot")) return;
    if (S.tool === "edit") {
      const ln = ev.target._line;
      if (ln) startEdit(pg, ln);
    } else if (S.tool === "add") {
      const [x, y] = ptOf(pg, ev);
      startAdd(pg, x, y);
    } else if (S.tool === "note") {
      addNote(pg, ptOf(pg, ev));
    } else if (S.tool === "select") {
      selectAnnot(null);
    }
  });
  layer.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || ev.target.closest(".editor, .widget, .annot")) return;
    const t = S.tool;
    if (t === "move") {
      const ln = ev.target._line;
      if (ln) { ev.preventDefault(); dragLine(pg, ln, ev); }
    } else if (RECT_TOOLS.has(t) || LINE_TOOLS.has(t) || t === "drawing") {
      if ((t === "image" || t === "sign") && !S.placing) return;
      ev.preventDefault();
      dragShape(pg, t, ev);
    }
  });
}

/** Rubber-band drag; resolves with page-point geometry. */
function dragShape(pg, tool, ev) {
  const layer = pg._layer, z = S.zoom;
  const p0 = ptOf(pg, ev);
  const color = $("cmtColor").value;
  let fb, path = [p0], p1 = p0;
  const svgNS = "http://www.w3.org/2000/svg";
  if (LINE_TOOLS.has(tool) || tool === "drawing") {
    fb = document.createElementNS(svgNS, "svg");
    fb.setAttribute("class", "sketch");
    const shape = document.createElementNS(svgNS, tool === "drawing" ? "polyline" : "line");
    shape.setAttribute("stroke", color);
    shape.setAttribute("stroke-width", $("cmtWidth").value * z);
    shape.setAttribute("fill", "none");
    fb.appendChild(shape);
    fb._shape = shape;
  } else {
    fb = el("div", "rubber" + (tool === "highlight" ? " hl" : tool === "erase" ? "" : " blue"));
  }
  layer.appendChild(fb);
  const draw = () => {
    if (fb._shape) {
      if (tool === "drawing") fb._shape.setAttribute("points", path.map((p) => p[0] * z + "," + p[1] * z).join(" "));
      else {
        fb._shape.setAttribute("x1", p0[0] * z); fb._shape.setAttribute("y1", p0[1] * z);
        fb._shape.setAttribute("x2", p1[0] * z); fb._shape.setAttribute("y2", p1[1] * z);
      }
    } else {
      box(fb, [Math.min(p0[0], p1[0]), Math.min(p0[1], p1[1]), Math.max(p0[0], p1[0]), Math.max(p0[1], p1[1])]);
    }
  };
  const move = (e) => {
    const p = ptOf(pg, e);
    const w = S.state.pages[pg._index].w, h = S.state.pages[pg._index].h;
    p1 = [Math.max(0, Math.min(w, p[0])), Math.max(0, Math.min(h, p[1]))];
    if (tool === "drawing") path.push(p1);
    draw();
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    fb.remove();
    const rect = [Math.min(p0[0], p1[0]), Math.min(p0[1], p1[1]), Math.max(p0[0], p1[0]), Math.max(p0[1], p1[1])];
    const click = rect[2] - rect[0] < 3 && rect[3] - rect[1] < 3;
    S.suppressClick = true;
    setTimeout(() => { S.suppressClick = false; }, 0);
    shapeDone(pg, tool, { rect, p0, p1, path, click });
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  draw();
}

async function shapeDone(pg, tool, g) {
  const pno = pg._index;
  const color = unhex($("cmtColor").value), width = +$("cmtWidth").value;
  let res = null;
  try {
    if (tool === "erase") {
      if (g.click) return;
      res = await post("/api/page/" + pno + "/erase", { rect: g.rect, color: sampleColor(pg, g.rect[0] - 2, g.rect[1] - 2) });
    } else if (tool === "textbox") {
      const r = g.click ? [g.p0[0], g.p0[1], g.p0[0] + 220, g.p0[1] + 70] : g.rect;
      if (r[2] - r[0] < 20) r[2] = r[0] + 120;
      if (r[3] - r[1] < 14) r[3] = r[1] + 40;
      startTextbox(pg, r);
      return;
    } else if (tool === "image" || tool === "sign") {
      const pl = S.placing;
      if (!pl) return;
      let r = g.rect;
      if (g.click || r[2] - r[0] < 8) {
        const w = Math.min(tool === "sign" ? 160 : 220, pl.w * 0.75);
        const h = w * pl.h / pl.w;
        r = [g.p0[0] - w / 2, g.p0[1] - h / 2, g.p0[0] + w / 2, g.p0[1] + h / 2];
      }
      const fd = new FormData();
      fd.append("file", pl.blob, pl.name || "image.png");
      fd.append("rect", r.join(","));
      res = await postForm("/api/page/" + pno + "/image", fd);
      S.placing = null;
      toast(tool === "sign" ? "Signature added." : "Image added.", "ok");
      setTool("edit");
    } else if (["highlight", "underline", "strikeout"].includes(tool)) {
      if (g.click) return;
      res = await post("/api/page/" + pno + "/annot", { kind: tool, rect: g.rect, color });
    } else if (tool === "rectangle" || tool === "ellipse") {
      if (g.click) return;
      res = await post("/api/page/" + pno + "/annot", { kind: tool, rect: g.rect, color, width });
    } else if (LINE_TOOLS.has(tool)) {
      if (g.click) return;
      res = await post("/api/page/" + pno + "/annot", { kind: tool, p1: g.p0, p2: g.p1, color, width });
    } else if (tool === "drawing") {
      if (g.path.length < 2) return;
      res = await post("/api/page/" + pno + "/annot", { kind: "drawing", paths: [g.path], color, width });
    }
  } catch (e) { toast(e.message, "err"); return; }
  if (res) pageChanged(pno, res.state);
}

async function pageChanged(pno, st) {
  S.state = st;
  S.pageVer[pno] = st.boot + "." + st.version;
  await loadPage(pno);
  refreshThumb(pno);
  syncButtons();
}

function dragLine(pg, ln, ev) {
  const z = S.zoom, p0 = ptOf(pg, ev);
  const g = el("div", "moveghost");
  const b = ln.bbox;
  box(g, b);
  pg._layer.appendChild(g);
  let d = [0, 0];
  const move = (e) => {
    const p = ptOf(pg, e);
    d = [p[0] - p0[0], p[1] - p0[1]];
    if (e.shiftKey) { if (Math.abs(d[0]) > Math.abs(d[1])) d[1] = 0; else d[0] = 0; }
    box(g, [b[0] + d[0], b[1] + d[1], b[2] + d[0], b[3] + d[1]]);
  };
  const up = async () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    if (Math.abs(d[0]) * z < 2 && Math.abs(d[1]) * z < 2) { g.remove(); return; }
    try {
      const segs = ln.spans.map((sp, i) => ({ src: i, text: sp.text }));
      const res = await post("/api/page/" + pg._index + "/edit", { line: ln, segs, move: d });
      await pageChanged(pg._index, res.state);
      reportFonts(res.result);
    } catch (e) { toast(e.message, "err"); }
    g.remove();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// =============================================================== comments
async function addNote(pg, p) {
  const v = await formDialog({
    title: "Add a note", ok: "Add note",
    fields: [{ name: "text", label: "Note", type: "textarea", rows: 4, full: true, placeholder: "Type your comment…" }],
  });
  if (!v || !v.text.trim()) return;
  try {
    const res = await post("/api/page/" + pg._index + "/annot", { kind: "note", point: p, text: v.text, color: unhex($("cmtColor").value) });
    pageChanged(pg._index, res.state);
  } catch (e) { toast(e.message, "err"); }
}

function selectAnnot(pg, a, div) {
  document.querySelectorAll(".annot.selected").forEach((n) => n.classList.remove("selected"));
  S.selAnnot = null;
  if (!pg || S.tool !== "select") return;
  S.selAnnot = { page: pg._index, xref: a.xref };
  div.classList.add("selected");
}

async function deleteAnnot(pg, a) {
  try {
    const res = await post("/api/page/" + pg._index + "/annot/delete", { xref: a.xref });
    S.selAnnot = null;
    pageChanged(pg._index, res.state);
  } catch (e) { toast(e.message, "err"); }
}

// ================================================================== forms
function widgetEl(pg, w) {
  const d = el("div", "widget");
  box(d, w.rect);
  let inp;
  if (w.type === "CheckBox" || w.type === "RadioButton") {
    inp = el("input"); inp.type = "checkbox"; inp.checked = !!w.checked;
  } else if (w.options) {
    inp = el("select");
    for (const o of w.options) { const op = el("option", null, o); op.value = o; inp.appendChild(op); }
    inp.value = w.value || "";
  } else if (w.type === "Text") {
    inp = el("input"); inp.type = "text"; inp.value = w.value || "";
    inp.style.fontSize = Math.max(9, Math.min(16, (w.rect[3] - w.rect[1]) * S.zoom * 0.62)) + "px";
  } else {
    return d;
  }
  inp.title = w.name;
  inp.disabled = w.readonly;
  inp.addEventListener("change", async () => {
    const value = inp.type === "checkbox" ? inp.checked : inp.value;
    try {
      const res = await post("/api/page/" + pg._index + "/widget", { xref: w.xref, value });
      S.state = res.state;
      S.pageVer[pg._index] = res.state.boot + "." + res.state.version;
      refreshThumb(pg._index);
      syncButtons();
    } catch (e) { toast(e.message, "err"); }
  });
  d.appendChild(inp);
  return d;
}

// ================================================================= editing
function makeEditor(pg, wrap) {
  const ed = el("div", "editor" + (wrap ? " wrap" : ""));
  ed.contentEditable = "true";
  ed.spellcheck = false;
  ed.addEventListener("keydown", (ev) => {
    const multi = S.edit && (S.edit.mode === "add" || S.edit.mode === "textbox");
    if (ev.key === "Enter" && (!multi || ev.ctrlKey) && !(multi && ev.shiftKey)) {
      ev.preventDefault();
      finishEdit();
    } else if (ev.key === "Enter" && multi) {
      ev.preventDefault();
      document.execCommand("insertText", false, "\n");
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      cancelEdit();
    }
    ev.stopPropagation();
  });
  ed.addEventListener("paste", (ev) => {
    ev.preventDefault();
    let t = (ev.clipboardData || window.clipboardData).getData("text") || "";
    if (!(S.edit && (S.edit.mode === "add" || S.edit.mode === "textbox"))) t = t.replace(/\s*\n\s*/g, " ");
    document.execCommand("insertText", false, t);
  });
  ed.addEventListener("drop", (ev) => ev.preventDefault());
  pg._layer.appendChild(ed);
  return ed;
}

function focusEnd(ed) {
  ed.focus();
  const sel = window.getSelection();
  sel.selectAllChildren(ed);
  sel.collapseToEnd();
}

async function startEdit(pg, line) {
  await finishEdit();
  if (S.tool !== "edit") return;
  const z = S.zoom, b = line.bbox;
  const straight = Math.abs(line.dir[0] - 1) < 1e-3 && Math.abs(line.dir[1]) < 1e-3;
  const ed = makeEditor(pg);
  const h = straight ? (b[3] - b[1]) : line.spans[0].size * 1.3;
  ed.style.left = b[0] * z - 2 + "px";
  ed.style.top = b[1] * z + "px";
  ed.style.padding = "0 2px";
  ed.style.height = h * z + "px";
  ed.style.lineHeight = h * z + "px";
  ed.style.minWidth = (straight ? (b[2] - b[0]) : 40) * z + 4 + "px";
  ed.style.background = hex(sampleColor(pg, b[0] - 1.5, b[1] - 1.5));
  line.spans.forEach((sp, i) => {
    const s = el("span", null, sp.ansi ? BijoyAnsi.toUnicode(sp.text) : sp.text);
    s.dataset.i = i;
    ed.appendChild(s);
  });
  S.edit = { mode: "line", pg, line, ed, ov: {} };
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

function unicodeBanglaFont() {
  for (const f of ["SutonnyOMJ", "NikoshBAN", "SolaimanLipi", "Kalpurush", "Nirmala UI"]) {
    if (S.families.some((x) => x.toLowerCase() === f.toLowerCase())) return f;
  }
  return "Nirmala UI";
}

/** Text for an ANSI (Bijoy) font has to be stored in the Bijoy encoding. */
function encodeFor(family, text) {
  return family && BijoyAnsi.isAnsiFont(family) ? BijoyAnsi.toAnsi(text) : text;
}

function defaultNewFont() {
  const typed = currentStyle().family;
  if (typed) return typed;
  if (BanglaInput.mode !== "en") {
    for (const f of ["NikoshBAN", "Nikosh", "SolaimanLipi", "Kalpurush", "Nirmala UI"]) {
      if (S.families.some((x) => x.toLowerCase() === f.toLowerCase())) return f;
    }
  }
  return "Arial";
}

async function startAdd(pg, x, y) {
  await finishEdit();
  if (S.tool !== "add") return;
  const z = S.zoom;
  const size = parseFloat($("size").value) || 12;
  const ed = makeEditor(pg);
  ed.style.left = x * z + "px";
  ed.style.top = (y - size * 0.6) * z + "px";
  ed.style.lineHeight = "1.2";
  ed.style.minWidth = size * z + "px";
  ed.style.minHeight = size * 1.2 * z + "px";
  ed.style.background = hex(sampleColor(pg, x, y));
  S.edit = { mode: "add", pg, ed, x, y: y - size * 0.6, ov: {}, family: defaultNewFont() };
  $("font").placeholder = S.edit.family;
  showFontBar();
  stylePreview();
  focusEnd(ed);
}

async function startTextbox(pg, r) {
  await finishEdit();
  const z = S.zoom;
  const ed = makeEditor(pg, true);
  box(ed, r);
  ed.style.minHeight = ed.style.height;
  ed.style.height = "auto";
  ed.style.lineHeight = "1.25";
  ed.style.padding = "0";
  ed.style.background = "rgba(255,255,255,.92)";
  S.edit = { mode: "textbox", pg, ed, rect: r, ov: {}, family: defaultNewFont() };
  $("font").placeholder = S.edit.family;
  showFontBar();
  stylePreview();
  focusEnd(ed);
}

function currentStyle() {
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
  if (e.mode === "add" || e.mode === "textbox") {
    const ed = e.ed, fam = st.family || e.family;
    ed.style.fontSize = st.size * z + "px";
    if (BijoyAnsi.isAnsiFont(fam)) {
      ed.style.color = hex(st.color);
      ed.style.fontFamily = '"' + unicodeBanglaFont() + '", "Nirmala UI", sans-serif';
      return;
    }
    ed.style.color = hex(st.color);
    ed.style.fontFamily = '"' + fam + '", Arial, "Nirmala UI", sans-serif';
    ed.style.fontWeight = st.bold ? "bold" : "normal";
    ed.style.fontStyle = st.italic ? "italic" : "normal";
    const key = "af" + hashStr(fam + "|" + st.bold + "|" + st.italic);
    e.faceKey = key;
    loadFace(key, "/api/fontface?family=" + encodeURIComponent(fam) +
      "&bold=" + (st.bold ? 1 : 0) + "&italic=" + (st.italic ? 1 : 0)).then((k) => {
      if (k && S.edit === e && e.faceKey === key) {
        ed.style.fontFamily = k + ', Arial, "Nirmala UI", sans-serif';
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
    // an installed Windows font is used by name: some older fonts (Nikosh, ...)
    // cannot be loaded as web fonts but display fine this way
    const fi = (e.pg._fonts || {})[sp.font + "|" + sp.flags] || {};
    const named = ov.family ? '"' + ov.family + '", ' : (fi.family ? '"' + fi.family + '", ' : "");
    s.style.fontFamily = named + genericFamily(sp.flags);
    s.style.fontWeight = bold ? "bold" : "normal";
    s.style.fontStyle = italic ? "italic" : "normal";
    if (sp.ansi && !ov.family) {
      s.style.fontFamily = '"' + unicodeBanglaFont() + '", "Nirmala UI", sans-serif';
      return;
    }
    let q = "page=" + e.pg._index + "&font=" + encodeURIComponent(sp.font) + "&flags=" + sp.flags;
    if (ov.family) q += "&family=" + encodeURIComponent(ov.family);
    if (ov.bold !== undefined) q += "&bold=" + (ov.bold ? 1 : 0);
    if (ov.italic !== undefined) q += "&italic=" + (ov.italic ? 1 : 0);
    const key = "pf" + hashStr(S.docId + "|" + S.fontGen + "|" + q);
    s.dataset.face = key;
    if (!ov.family && (fi.family || fi.kind === "builtin")) return;
    loadFace(key, "/api/fontface?" + q).then((k) => {
      if (k && s.dataset.face === key) {
        s.style.fontFamily = k + ", " + named + genericFamily(sp.flags);
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
      const fi = (e.pg._fonts || {})[key] || { label: sp.name, kind: "system" };
      let cls = "ok", txt = "✓ Same font";
      const missing = fi.kind === "similar" || fi.kind === "substitute";
      if (e.ov.family) { cls = "warn"; txt = "Changed to " + e.ov.family; }
      else if (fi.kind === "similar") { cls = "warn"; txt = "Not installed — similar font: " + fi.label; }
      else if (fi.kind === "substitute") { cls = "bad"; txt = "Not on this PC — using " + fi.label; }
      else if (fi.kind === "embedded") txt = "✓ Same font (from the PDF)";
      if (sp.ansi && !e.ov.family) txt += " · Bijoy (ANSI) text";
      const item = el("span");
      const name = el("b", null, sp.name + " · " + (+sp.size.toFixed(1)) + " pt");
      const chip = el("span", "chip " + cls, txt);
      item.append(name, chip);
      if (missing && !e.ov.family) {
        const get = el("button", "getfont", "Get it online");
        get.title = "Download “" + sp.name + "” from the internet";
        get.onmousedown = (ev) => ev.preventDefault();
        get.onclick = () => { const slot = el("span"); get.replaceWith(slot); getFontOnline(sp.name, slot); };
        item.appendChild(get);
      }
      bar.appendChild(item);
    });
  } else {
    bar.appendChild(el("span", null, e.mode === "textbox" ? "Text box — the text wraps inside the box" :
      "New text — choose the font, size and colour in the toolbar"));
  }
  const keys = el("span", "keys");
  keys.innerHTML = e.mode === "line" ? "<kbd>Enter</kbd> apply &nbsp; <kbd>Esc</kbd> cancel"
    : "<kbd>Ctrl</kbd>+<kbd>Enter</kbd> apply &nbsp; <kbd>Enter</kbd> new line &nbsp; <kbd>Esc</kbd> cancel";
  if (e.mode === "add") keys.innerHTML = "<kbd>Enter</kbd> apply &nbsp; <kbd>Shift</kbd>+<kbd>Enter</kbd> new line &nbsp; <kbd>Esc</kbd> cancel";
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
  const pno = e.pg._index;
  let res;
  e.ed.contentEditable = "false";
  e.ed.classList.add("pending");
  try {
    if (e.mode === "add" || e.mode === "textbox") {
      const text = e.ed.innerText.replace(/ /g, " ").replace(/\n+$/, "");
      if (!text.trim()) { e.ed.remove(); return; }
      const st = currentStyle();
      const fam = st.family || e.family;
      const base = { text: encodeFor(fam, text), family: fam, bold: st.bold, italic: st.italic, size: st.size, color: st.color };
      res = e.mode === "add"
        ? await post("/api/page/" + pno + "/add_text", Object.assign({ x: e.x, y: e.y }, base))
        : await post("/api/page/" + pno + "/textbox", Object.assign({ rect: e.rect }, base));
    } else {
      const segs = collectSegs(e.ed);
      const shown = (sp) => (sp.ansi ? BijoyAnsi.toUnicode(sp.text) : sp.text);
      const same = !Object.keys(e.ov).length && e.line.spans.every((sp, i) => {
        const sg = segs.filter((s) => s.src === i).map((s) => s.text).join("");
        return sg === shown(sp);
      });
      if (same) { e.ed.remove(); return; }
      for (const sg of segs) {
        const sp = e.line.spans[sg.src];
        const target = e.ov.family || (sp && sp.ansi ? sp.font : null);
        if (sp && sp.ansi && !e.ov.family) sg.text = BijoyAnsi.toAnsi(sg.text);
        else if (e.ov.family) sg.text = encodeFor(target, sg.text);
      }
      res = await post("/api/page/" + pno + "/edit", { line: e.line, segs, ov: e.ov });
    }
    await pageChanged(pno, res.state);
    reportFonts(res.result);
  } finally {
    e.ed.remove();
  }
}

function reportFonts(result) {
  if (!result || !result.changed) return;
  const bad = (result.fonts || []).filter((f) => f.kind === "substitute" || f.kind === "similar");
  if (bad.length) {
    toast("Original font is not on this PC — used " + bad.map((f) => f.label).join(", ") +
      ". Use “Get it online” or “Fonts” to download it for an exact match.", "warn", 7000);
  }
}

// ============================================================ online fonts
async function loadFonts() {
  try {
    const d = await api("/api/fonts");
    setFamilies(d.families);
  } catch (e) { /* ignore */ }
}

function setFamilies(list) {
  S.families = list;
  const dl = $("fontlist");
  dl.innerHTML = "";
  const frag = document.createDocumentFragment();
  list.forEach((f) => { const o = el("option"); o.value = f; frag.appendChild(o); });
  dl.appendChild(frag);
}

function fontError(msg) {
  if (msg === "NO_INTERNET") return "No internet connection — connect to the internet to download fonts. (ইন্টারনেট সংযোগ নেই)";
  if (msg === "NOT_FOUND") return "This font is not available online (it may be a paid font). Install it on the PC or add it with “+ Font”.";
  return msg;
}

/** Download a font with a progress bar shown in `slot` (replaces its content). */
async function downloadFont(name, slot) {
  const prog = el("span", "prog");
  const bar = el("span", "bar");
  const fill = el("i");
  bar.appendChild(fill);
  const pct = el("span", "pct", "Starting…");
  prog.append(bar, pct);
  slot.innerHTML = "";
  slot.appendChild(prog);
  const fail = (msg) => {
    prog.classList.add("fail");
    pct.textContent = fontError(msg);
    bar.remove();
    const again = el("button", "btn", "Try again");
    again.onclick = () => downloadFont(name, slot);
    slot.appendChild(again);
    return false;
  };
  let job;
  try { job = (await post("/api/fonts/online/start", { family: name })).job; } catch (e) { return fail(e.message); }
  for (;;) {
    await new Promise((r) => setTimeout(r, 250));
    let st;
    try { st = await api("/api/fonts/online/job/" + job); } catch (e) { return fail(e.message); }
    fill.style.width = (st.percent || 0) + "%";
    if (st.state === "running") { pct.textContent = "Downloading " + (st.percent || 0) + "%"; continue; }
    if (st.state === "error") return fail(st.error);
    fill.style.width = "100%";
    prog.classList.add("done");
    pct.textContent = "✓ Complete";
    setFamilies(st.families);
    S.fontGen = (S.fontGen || 0) + 1;
    await refreshFontsOnPages();
    toast("Font installed and in use: " + st.added.join(", "), "ok");
    return true;
  }
}

async function getFontOnline(name, slot) {
  if (!slot) { slot = el("span"); $("fontbar").appendChild(slot); }
  const ok = await downloadFont(name, slot);
  if (ok) setTimeout(checkMissingFonts, 1500);
}

/** Banner at the top listing fonts the PDF uses that this PC does not have. */
async function checkMissingFonts() {
  const box = $("fontalert");
  let list = [];
  try { list = (await api("/api/fonts/missing")).missing; } catch (e) { /* ignore */ }
  S.dismissedFonts = S.dismissedFonts || new Set();
  list = list.filter((m) => !S.dismissedFonts.has(m.name));
  box.innerHTML = "";
  if (!list.length) { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  const head = el("div", "fa-head");
  head.innerHTML = "<svg><use href='#i-font'/></svg>";
  head.appendChild(el("b", null, list.length > 1 ? "These fonts are not on this PC" : "This font is not on this PC"));
  head.appendChild(el("span", "fa-sub", "— download it so edited text uses the same font. (এই ফন্ট কম্পিউটারে নেই — অনলাইন থেকে ডাউনলোড করুন)"));
  const x = el("button", "x fa-x", "✕");
  x.title = "Hide";
  x.onclick = () => { list.forEach((m) => S.dismissedFonts.add(m.name)); box.classList.add("hidden"); };
  head.appendChild(x);
  box.appendChild(head);
  for (const m of list) {
    const row = el("div", "fa-row");
    row.appendChild(el("span", "fa-name", m.name));
    row.appendChild(el("span", "fa-using", "now shown with: " + m.using));
    const slot = el("span");
    const b = el("button", "btn primary", "Download");
    b.onclick = async () => {
      const ok = await downloadFont(m.name, slot);
      if (ok) setTimeout(checkMissingFonts, 4000);
    };
    slot.appendChild(b);
    row.appendChild(slot);
    box.appendChild(row);
  }
}

async function refreshFontsOnPages() {
  const loads = S.pageEls.filter((pg) => pg._visible).map((pg) => loadPage(pg._index, true));
  await Promise.all(loads);
  if (S.edit) { showFontBar(); stylePreview(); }
}

async function fontsDialog() {
  const wrap = el("div");
  const q = el("input", "field");
  q.placeholder = "Search fonts, e.g. Nikosh, SolaimanLipi, Roboto…";
  q.style.width = "100%";
  q.dataset.latin = "";
  const results = el("div", "fontresults");
  const add = el("button", "btn ghost", "+ Add a font file from this PC");
  add.style.marginTop = "10px";
  add.onclick = () => $("fontfile").click();
  wrap.append(q, results, add);
  let timer = null, seq = 0;
  const search = async () => {
    const my = ++seq;
    results.innerHTML = "<div class='msg'>Searching…</div>";
    try {
      const d = await api("/api/fonts/online?q=" + encodeURIComponent(q.value.trim()));
      if (my !== seq) return;
      results.innerHTML = "";
      if (!d.results.length) results.innerHTML = "<div class='msg'>No fonts found.</div>";
      d.results.forEach((name) => {
        const row = el("div", "fr");
        const installed = S.families.some((f) => f.toLowerCase().replace(/\s/g, "") === name.toLowerCase().replace(/\s/g, ""));
        row.appendChild(el("span", null, name));
        const b = el("button", "btn" + (installed ? "" : " primary"), installed ? "Installed" : "Download");
        b.disabled = installed;
        const slot = el("span");
        b.onclick = async () => {
          if (await downloadFont(name, slot)) setTimeout(checkMissingFonts, 1500);
        };
        slot.appendChild(b);
        row.appendChild(slot);
        results.appendChild(row);
      });
    } catch (e) {
      if (my !== seq) return;
      results.innerHTML = "";
      results.appendChild(el("div", "msg", fontError(e.message)));
    }
  };
  q.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(search, 350); });
  search();
  await dialog({ title: "Fonts", message: "Download free fonts — the Bangla government / Ekushey fonts and the whole Google Fonts library.", body: wrap, ok: false, cancel: "Close", wide: true });
}

// ============================================================ image & sign
async function chooseImage() {
  const files = await pickFile("image/*");
  if (!files.length) { setTool("edit"); return; }
  const f = files[0];
  const url = URL.createObjectURL(f);
  const img = new Image();
  img.onload = () => {
    S.placing = { blob: f, name: f.name, w: img.naturalWidth, h: img.naturalHeight };
    URL.revokeObjectURL(url);
    toast("Click on the page (or drag a box) to place the image.", "ok", 5000);
  };
  img.onerror = () => { toast("That file is not an image.", "err"); setTool("edit"); };
  img.src = url;
}

function savedSignatures() {
  try { return JSON.parse(localStorage.getItem("signatures") || "[]"); } catch (e) { return []; }
}

async function signatureDialog() {
  const wrap = el("div");
  const tabs = el("div", "segmented sigtabs");
  const bDraw = el("button", "active", "Draw"), bType = el("button", null, "Type");
  tabs.append(bDraw, bType);
  const canvas = el("canvas", "sigpad");
  const typeRow = el("div", "sigrow hidden");
  const name = el("input", "field");
  name.placeholder = "Type your name";
  name.style.flex = "1";
  const fontSel = el("select", "field");
  ["Segoe Script", "Lucida Handwriting", "Brush Script MT", "Ink Free", "Gabriola", "NikoshBAN", "SolaimanLipi"].forEach((f) => {
    const o = el("option", null, f); o.value = f; fontSel.appendChild(o);
  });
  typeRow.append(name, fontSel);
  const row = el("div", "sigrow");
  const colorSw = el("label", "swatch");
  const color = el("input"); color.type = "color"; color.value = "#0b2a8a";
  colorSw.appendChild(color);
  const clear = el("button", "btn", "Clear");
  const keep = el("label", "check");
  const keepBox = el("input"); keepBox.type = "checkbox"; keepBox.checked = true;
  keep.append(keepBox, document.createTextNode(" Save for next time"));
  row.append(el("span", null, "Ink"), colorSw, clear, keep);
  const savedWrap = el("div", "sigsaved");
  wrap.append(tabs, canvas, typeRow, row, savedWrap);

  let mode = "draw", drawn = false, chosen = null;
  const ctx = canvas.getContext("2d");
  const fit = () => {
    const r = canvas.getBoundingClientRect();
    canvas.width = Math.max(300, r.width * 2); canvas.height = 340;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    renderTyped();
  };
  const renderTyped = () => {
    if (mode !== "type") return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = color.value;
    ctx.font = "110px '" + fontSel.value + "'";
    ctx.textBaseline = "middle";
    ctx.fillText(name.value, 30, canvas.height / 2, canvas.width - 60);
  };
  let last = null;
  canvas.addEventListener("pointerdown", (ev) => {
    if (mode !== "draw") return;
    const r = canvas.getBoundingClientRect();
    last = [(ev.clientX - r.left) * canvas.width / r.width, (ev.clientY - r.top) * canvas.height / r.height];
    canvas.setPointerCapture(ev.pointerId);
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!last) return;
    const r = canvas.getBoundingClientRect();
    const p = [(ev.clientX - r.left) * canvas.width / r.width, (ev.clientY - r.top) * canvas.height / r.height];
    ctx.strokeStyle = color.value; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(last[0], last[1]); ctx.lineTo(p[0], p[1]); ctx.stroke();
    last = p; drawn = true;
  });
  canvas.addEventListener("pointerup", () => { last = null; });
  clear.onclick = () => { ctx.clearRect(0, 0, canvas.width, canvas.height); drawn = false; };
  bDraw.onclick = () => { mode = "draw"; bDraw.classList.add("active"); bType.classList.remove("active"); typeRow.classList.add("hidden"); clear.click(); };
  bType.onclick = () => { mode = "type"; bType.classList.add("active"); bDraw.classList.remove("active"); typeRow.classList.remove("hidden"); renderTyped(); name.focus(); };
  name.addEventListener("input", renderTyped);
  fontSel.addEventListener("change", renderTyped);
  color.addEventListener("input", renderTyped);

  const paintSaved = () => {
    savedWrap.innerHTML = "";
    savedSignatures().forEach((src, i) => {
      const s = el("div", "s");
      const im = el("img"); im.src = src;
      const x = el("b", null, "×");
      x.onclick = (ev) => { ev.stopPropagation(); const l = savedSignatures(); l.splice(i, 1); localStorage.setItem("signatures", JSON.stringify(l)); paintSaved(); };
      s.onclick = () => { chosen = src; $("modalOk").click(); };
      s.append(im, x);
      savedWrap.appendChild(s);
    });
  };
  paintSaved();
  setTimeout(fit, 30);

  const ok = await dialog({
    title: "Signature", message: "Draw or type your signature, then click on the page where it should go.",
    body: wrap, ok: "Use signature", wide: true,
    onOk: () => {
      if (chosen) return chosen;
      if (mode === "draw" && !drawn) { toast("Draw your signature first.", "warn"); return false; }
      if (mode === "type" && !name.value.trim()) { toast("Type your name first.", "warn"); return false; }
      return trimCanvas(canvas);
    },
  });
  if (!ok) { setTool("edit"); return; }
  if (!chosen && keepBox.checked) {
    const l = savedSignatures(); l.unshift(ok); localStorage.setItem("signatures", JSON.stringify(l.slice(0, 6)));
  }
  const blob = await (await fetch(ok)).blob();
  const im = new Image();
  im.onload = () => {
    S.placing = { blob, name: "signature.png", w: im.naturalWidth / 2, h: im.naturalHeight / 2 };
    toast("Click on the page (or drag a box) to place your signature.", "ok", 5000);
  };
  im.src = ok;
}

function trimCanvas(c) {
  const g = c.getContext("2d");
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let x0 = c.width, y0 = c.height, x1 = 0, y1 = 0;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    if (d[(y * c.width + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 <= x0 || y1 <= y0) return c.toDataURL("image/png");
  const pad = 8, out = document.createElement("canvas");
  out.width = x1 - x0 + pad * 2; out.height = y1 - y0 + pad * 2;
  out.getContext("2d").drawImage(c, x0 - pad, y0 - pad, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL("image/png");
}

// ========================================================= find & replace
function openFind() {
  if (!needDoc()) return;
  $("findPanel").classList.remove("hidden");
  $("findText").focus();
  $("findText").select();
}

async function doFind() {
  const q = $("findText").value;
  const out = $("findResults");
  out.innerHTML = "";
  if (!q) return;
  try {
    const d = await post("/api/find", { query: q, case: $("findCase").checked });
    if (!d.results.length) { out.appendChild(el("div", "empty-r", "No matches.")); return; }
    out.appendChild(el("div", "empty-r", d.results.reduce((n, r) => n + r.count, 0) + " match(es)"));
    d.results.forEach((r) => {
      const item = el("div", "r");
      item.appendChild(el("small", null, "Page " + (r.page + 1)));
      item.appendChild(document.createTextNode(r.text.length > 90 ? r.text.slice(0, 90) + "…" : r.text));
      item.onclick = () => flashResult(r);
      out.appendChild(item);
    });
  } catch (e) { toast(e.message, "err"); }
}

async function flashResult(r) {
  scrollToPage(r.page, r.bbox[1]);
  const pg = S.pageEls[r.page];
  await loadPage(r.page);
  const f = el("div", "flash");
  box(f, r.bbox);
  pg._layer.appendChild(f);
  setTimeout(() => f.remove(), 1700);
}

async function doReplace() {
  const q = $("findText").value;
  if (!q) return;
  await finishEdit();
  const r = await run("Replacing…", () => post("/api/replace", { query: q, repl: $("replText").value, case: $("findCase").checked }));
  if (!r) return;
  applyState(r.state);
  toast(r.result.count ? "Replaced in " + r.result.count + " line(s)." : "Nothing was replaced.", r.result.count ? "ok" : "warn");
  doFind();
}

// =============================================================== tools tab
async function watermarkDialog() {
  if (!needDoc()) return;
  const v = await formDialog({
    title: "Watermark", ok: "Add watermark",
    fields: [
      { name: "text", label: "Text", value: "CONFIDENTIAL" },
      { name: "family", label: "Font", type: "font" },
      { name: "size", label: "Size", type: "number", value: 60, min: 6, max: 300 },
      { name: "color", label: "Colour", type: "color", value: "#888888" },
      { name: "opacity", label: "Opacity (%)", type: "number", value: 25, min: 5, max: 100 },
      { name: "angle", label: "Angle", type: "select", value: "45", options: [["0", "Horizontal"], ["45", "Diagonal 45°"], ["-45", "Diagonal −45°"], ["90", "Vertical"]] },
      { name: "pages", label: "Pages", value: "all", placeholder: "all, or e.g. 1-3,5" },
    ],
  });
  if (!v) return;
  const r = await run("Adding watermark…", () => post("/api/watermark", {
    text: v.text, family: v.family, size: +v.size, color: unhex(v.color), opacity: +v.opacity / 100, angle: +v.angle, pages: v.pages,
  }));
  if (r) { applyState(r.state); toast("Watermark added.", "ok"); }
}

async function headerDialog(preset) {
  if (!needDoc()) return;
  const v = await formDialog({
    title: preset ? "Page numbers" : "Header & footer", ok: "Add",
    message: "Use {n} for the page number, {total} for the page count and {date} for today's date.",
    fields: [
      { name: "text", label: "Text", value: preset ? "Page {n} of {total}" : "" },
      { name: "position", label: "Position", type: "select", value: preset ? "bottom-center" : "top-center", options: [
        ["top-left", "Top left"], ["top-center", "Top centre"], ["top-right", "Top right"],
        ["bottom-left", "Bottom left"], ["bottom-center", "Bottom centre"], ["bottom-right", "Bottom right"]] },
      { name: "family", label: "Font", type: "font" },
      { name: "size", label: "Size", type: "number", value: 10, min: 4, max: 72 },
      { name: "color", label: "Colour", type: "color", value: "#333333" },
      { name: "margin", label: "Margin (pt)", type: "number", value: 28, min: 4, max: 200 },
      { name: "start", label: "First number", type: "number", value: 1, min: 0 },
      { name: "pages", label: "Pages", value: "all", placeholder: "all, or e.g. 2-10" },
    ],
  });
  if (!v) return;
  const r = await run("Adding…", () => post("/api/header_footer", {
    text: v.text, position: v.position, family: v.family, size: +v.size, color: unhex(v.color),
    margin: +v.margin, start: +v.start, pages: v.pages,
  }));
  if (r) { applyState(r.state); toast("Added to the pages.", "ok"); }
}

async function protectDialog() {
  if (!needDoc()) return;
  const v = await formDialog({
    title: "Password protection", ok: "Set password",
    message: "The downloaded PDF will need this password to open. Leave both empty to remove the password.",
    fields: [
      { name: "pw", label: "Password", type: "password", value: S.protectPw },
      { name: "pw2", label: "Confirm", type: "password", value: S.protectPw },
    ],
    validate: (x) => (x.pw !== x.pw2 ? "The two passwords are different." : null),
  });
  if (!v) return;
  S.protectPw = v.pw;
  $("protectLabel").textContent = v.pw ? "Password ✓" : "Password";
  toast(v.pw ? "The PDF will be password protected when you download it." : "Password removed.", "ok");
}

async function exportImagesDialog() {
  if (!needDoc()) return;
  const v = await formDialog({
    title: "Export pages as images", ok: "Export",
    fields: [
      { name: "fmt", label: "Format", type: "select", value: "png", options: [["png", "PNG"], ["jpg", "JPG"]] },
      { name: "dpi", label: "Quality", type: "select", value: "150", options: [["72", "Screen (72 dpi)"], ["150", "Good (150 dpi)"], ["300", "Print (300 dpi)"]] },
      { name: "pages", label: "Pages", value: "all", placeholder: "all, or e.g. 1-3" },
    ],
  });
  if (!v) return;
  download("/api/export_images?fmt=" + v.fmt + "&dpi=" + v.dpi + "&pages=" + encodeURIComponent(v.pages));
}

async function propertiesDialog() {
  if (!needDoc()) return;
  let m;
  try { m = await api("/api/metadata"); } catch (e) { toast(e.message, "err"); return; }
  const v = await formDialog({
    title: "Document properties", ok: "Save",
    fields: [
      { name: "title", label: "Title", value: m.title },
      { name: "author", label: "Author", value: m.author },
      { name: "subject", label: "Subject", value: m.subject },
      { name: "keywords", label: "Keywords", value: m.keywords },
      { name: "_c", type: "note", label: "Created with: " + (m.creator || "—") + " · " + (m.producer || "—") },
    ],
  });
  if (!v) return;
  delete v._c;
  const r = await run("Saving…", () => post("/api/metadata", v));
  if (r) { applyState(r.state, S.cur); toast("Properties saved.", "ok"); }
}

async function extractDialog() {
  if (!needDoc()) return;
  const sel = selectedPages().map((p) => p + 1).join(",");
  const v = await formDialog({
    title: "Extract pages", ok: "Extract",
    message: "Saves the chosen pages as a new PDF. The open document is not changed.",
    fields: [{ name: "pages", label: "Pages", value: sel, placeholder: "e.g. 1-3,5" }],
  });
  if (!v) return;
  const n = S.state.pages.length, list = [];
  for (const part of v.pages.replace(/\s/g, "").split(",")) {
    if (!part) continue;
    const [a, b] = part.split("-");
    const lo = Math.max(1, +a || 1), hi = Math.min(n, b === undefined ? lo : (+b || n));
    for (let k = lo; k <= hi; k++) list.push(k - 1);
  }
  if (!list.length) { toast("No valid pages.", "warn"); return; }
  download("/api/extract?pages=" + list.join(","));
}

// ============================================================= save, print
async function download(path) {
  await finishEdit();
  if (window.pywebview && window.pywebview.api && window.pywebview.api.save_url) {
    busy(true, "Saving…");
    try {
      const r = await window.pywebview.api.save_url(path);
      busy(false);
      if (r && r.saved) toast("Saved: " + r.path, "ok", 6000);
      else if (r && r.error) toast("Could not save: " + r.error, "err");
    } catch (e) { busy(false); toast(String(e), "err"); }
  } else {
    const a = document.createElement("a");
    a.href = path;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast("Downloading…", "ok");
  }
}

async function save() {
  if (!S.state || !S.state.open) return;
  download("/api/download" + (S.protectPw ? "?password=" + encodeURIComponent(S.protectPw) : ""));
}

async function printDoc() {
  await finishEdit();
  if (!needDoc()) return;
  busy(true, "Preparing to print…");
  const fr = $("printFrame");
  const pages = S.state.pages;
  const html = "<!doctype html><html><head><style>@page{margin:0}body{margin:0}img{display:block;width:100%;page-break-after:always}" +
    "img:last-child{page-break-after:auto}</style></head><body>" +
    pages.map((p, i) => "<img src='/api/page/" + i + ".png?scale=2.2&v=" + S.docId + ":" + S.pageVer[i] + "'>").join("") + "</body></html>";
  fr.srcdoc = html;
  fr.onload = async () => {
    const imgs = Array.from(fr.contentDocument.images);
    await Promise.all(imgs.map((im) => im.complete ? 0 : new Promise((r) => { im.onload = im.onerror = r; })));
    busy(false);
    fr.contentWindow.focus();
    fr.contentWindow.print();
  };
}

async function undoRedo(what) {
  await finishEdit();
  if (!S.state || !S.state.open) return;
  try {
    const r = await post("/api/" + what);
    applyState(r.state);
  } catch (e) { toast(e.message, "err"); }
}

// ================================================================ tabs/tools
function setTab(t) {
  finishEdit();
  S.tab = t;
  document.body.className = document.body.className.replace(/\btab-\w+/g, "").trim() + " tab-" + t;
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === t));
  document.querySelectorAll(".rgroup[data-for]").forEach((g) => g.classList.toggle("hidden", g.dataset.for !== t));
  setTool(TAB_DEFAULT_TOOL[t]);
}

function setTool(t) {
  finishEdit();
  S.tool = t;
  S.placing = t === "image" || t === "sign" ? S.placing : null;
  document.body.className = document.body.className.replace(/\btool-\w+/g, "").trim() + " tool-" + t;
  document.querySelectorAll(".tool").forEach((b) => b.classList.toggle("active", b.dataset.tool === t));
  if (TOOL_COLORS[t]) $("cmtColor").value = S.toolColor[t] || TOOL_COLORS[t];
  selectAnnot(null);
}

async function onToolButton(t) {
  if (!needDoc()) return;
  if (t === "image") { setTool("image"); S.placing = null; await chooseImage(); return; }
  if (t === "sign") { setTool("sign"); S.placing = null; await signatureDialog(); return; }
  setTool(t);
  if (t === "form") {
    const any = S.pageEls.some((pg) => (pg._widgets || []).length);
    if (!any) toast("This PDF has no form fields to fill (checked the pages loaded so far).", "warn");
  }
}

async function onAction(a) {
  switch (a) {
    case "open-pdf": $("file").accept = "application/pdf,.pdf"; $("file").click(); break;
    case "open-images": $("file").accept = "image/*"; $("file").click(); break;
    case "find": openFind(); break;
    case "find-close": $("findPanel").classList.add("hidden"); break;
    case "find-go": doFind(); break;
    case "replace-all": doReplace(); break;
    case "page-blank": { const s = selectedPages(); pageAction("insert_blank", { at: s[s.length - 1] + 1 }); break; }
    case "page-duplicate": pageAction("duplicate", { page: selectedPages()[0] }); break;
    case "page-rotl": pageAction("rotate", { pages: selectedPages(), deg: -90 }); break;
    case "page-rotr": pageAction("rotate", { pages: selectedPages(), deg: 90 }); break;
    case "page-extract": extractDialog(); break;
    case "page-delete": {
      if (!needDoc()) break;
      const s = selectedPages();
      if (await dialog({ title: "Delete " + (s.length > 1 ? s.length + " pages" : "page " + (s[0] + 1)) + "?", message: "You can bring them back with Undo.", ok: "Delete", danger: true })) {
        S.sel = new Set([Math.max(0, s[0] - 1)]);
        pageAction("delete", { pages: s });
      }
      break;
    }
    case "page-insert-pdf": case "page-insert-images": {
      if (!needDoc()) break;
      const pdf = a === "page-insert-pdf";
      const files = await pickFile(pdf ? "application/pdf,.pdf" : "image/*", !pdf);
      if (!files.length) break;
      const fd = new FormData();
      files.forEach((f) => fd.append("file", f));
      const s = selectedPages();
      fd.append("at", s[s.length - 1] + 1);
      const r = await run("Inserting…", () => postForm("/api/pages/" + (pdf ? "insert_pdf" : "insert_images"), fd));
      if (r) { applyState(r.state); toast(r.result.pages + " page(s) inserted.", "ok"); }
      break;
    }
    case "watermark": watermarkDialog(); break;
    case "header": headerDialog(false); break;
    case "pagenum": headerDialog(true); break;
    case "protect": protectDialog(); break;
    case "export-images": exportImagesDialog(); break;
    case "properties": propertiesDialog(); break;
    case "flatten": {
      if (!needDoc()) break;
      if (await dialog({ title: "Flatten form?", message: "Filled-in fields become normal page content and can no longer be changed as a form.", ok: "Flatten" })) {
        const r = await run("Flattening…", () => post("/api/flatten"));
        if (r) applyState(r.state);
      }
      break;
    }
    default: break;
  }
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
  S.pageEls.forEach((pg, i) => {
    sizePage(pg);
    drawLayer(pg);
    if (pg._visible) loadPage(i);
  });
  main.scrollTop = ratio * main.scrollHeight;
  syncButtons();
  requestAnimationFrame(snapPages);
}

function syncKb(m) {
  document.querySelectorAll("#kbMode button").forEach((b) => b.classList.toggle("active", b.dataset.kb === m));
  $("kbLabel").textContent = m === "avro" ? "বাংলা · অভ্র (F12)" : m === "bijoy" ? "বাংলা · বিজয় (F12)" : "";
  if (S.edit && (S.edit.mode === "add" || S.edit.mode === "textbox") && !currentStyle().family) {
    S.edit.family = defaultNewFont();
    $("font").placeholder = S.edit.family;
    stylePreview();
  }
}

// ==================================================================== init
function init() {
  S.toolColor = Object.assign({}, TOOL_COLORS);
  $("btnOpen").onclick = (ev) => { ev.stopPropagation(); $("openMenu").classList.toggle("hidden"); };
  $("btnOpen2").onclick = () => { $("file").accept = "application/pdf,.pdf,image/*"; $("file").click(); };
  document.addEventListener("click", () => $("openMenu").classList.add("hidden"));
  $("file").onchange = (ev) => { openFiles(Array.from(ev.target.files)); ev.target.value = ""; };
  $("btnSave").onclick = save;
  $("btnPrint").onclick = printDoc;
  $("btnUndo").onclick = () => undoRedo("undo");
  $("btnRedo").onclick = () => undoRedo("redo");
  $("btnFonts").onclick = fontsDialog;
  document.querySelectorAll("#tabs button").forEach((b) => { b.onclick = () => setTab(b.dataset.tab); });
  document.querySelectorAll(".tool").forEach((b) => { b.onclick = () => onToolButton(b.dataset.tool); });
  document.querySelectorAll("[data-act]").forEach((b) => { b.addEventListener("click", () => onAction(b.dataset.act)); });
  document.querySelectorAll("#kbMode button").forEach((b) => { b.onclick = () => BanglaInput.setMode(b.dataset.kb); });
  BanglaInput.onChange(syncKb);
  $("btnZoomIn").onclick = () => setZoom(S.zoom * 1.2);
  $("btnZoomOut").onclick = () => setZoom(S.zoom / 1.2);
  $("btnFit").onclick = () => setZoom(fitZoom());
  $("btnBold").onclick = () => { setToggle("bold", !S.bold); styleChanged("bold"); };
  $("btnItalic").onclick = () => { setToggle("italic", !S.italic); styleChanged("italic"); };
  $("font").addEventListener("change", () => styleChanged("family"));
  $("font").addEventListener("focus", () => $("font").select());
  $("size").addEventListener("input", () => styleChanged("size"));
  $("color").addEventListener("input", () => styleChanged("color"));
  $("cmtColor").addEventListener("input", () => { if (TOOL_COLORS[S.tool]) S.toolColor[S.tool] = $("cmtColor").value; });
  $("font").addEventListener("keydown", (ev) => { if (ev.key === "Enter") styleChanged("family"); ev.stopPropagation(); });
  $("size").addEventListener("keydown", (ev) => ev.stopPropagation());
  $("findText").addEventListener("keydown", (ev) => { if (ev.key === "Enter") doFind(); ev.stopPropagation(); });
  $("replText").addEventListener("keydown", (ev) => { if (ev.key === "Enter") doReplace(); ev.stopPropagation(); });
  $("fontfile").onchange = async (ev) => {
    const fd = new FormData();
    for (const f of ev.target.files) fd.append("file", f);
    ev.target.value = "";
    const r = await run("Adding font…", () => postForm("/api/fonts/add", fd));
    if (r) {
      setFamilies(r.families);
      S.fontGen = (S.fontGen || 0) + 1;
      toast("Font added: " + r.added.join(", "), "ok");
      refreshFontsOnPages();
    }
  };

  // keep toolbar buttons from stealing focus from the text box
  for (const id of ["toolbar", "ribbon"]) {
    $(id).addEventListener("mousedown", (ev) => { if (ev.target.closest("button")) ev.preventDefault(); });
  }
  // clicking outside the text box applies the edit
  document.addEventListener("mousedown", (ev) => {
    if (!S.edit) return;
    if (ev.target.closest(".editor, #toolbar, #ribbon, #fontbar, .statusbar, .overlay, #findPanel")) return;
    if (ev.target.closest(".layer") && (S.tool === "add" || S.tool === "textbox")) S.suppressClick = true;
    finishEdit();
  }, true);

  $("main").addEventListener("scroll", updateCurrentPage, { passive: true });
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!S.state || !S.state.open) return;
      S.pageEls.forEach((pg) => { sizePage(pg); if (pg._visible) loadPage(pg._index); });
      snapPages();
    }, 150);
  });
  window.addEventListener("keydown", (ev) => {
    const k = ev.key.toLowerCase();
    const typing = ev.target.closest && ev.target.closest("input, textarea, select, [contenteditable=true]");
    if (ev.ctrlKey && k === "o") { ev.preventDefault(); onAction("open-pdf"); }
    else if (ev.ctrlKey && k === "s") { ev.preventDefault(); save(); }
    else if (ev.ctrlKey && k === "p") { ev.preventDefault(); printDoc(); }
    else if (ev.ctrlKey && k === "f") { ev.preventDefault(); openFind(); }
    else if (ev.ctrlKey && k === "z" && !ev.shiftKey && !typing) { ev.preventDefault(); undoRedo("undo"); }
    else if (ev.ctrlKey && (k === "y" || (k === "z" && ev.shiftKey)) && !typing) { ev.preventDefault(); undoRedo("redo"); }
    else if (ev.ctrlKey && (k === "=" || k === "+")) { ev.preventDefault(); setZoom(S.zoom * 1.2); }
    else if (ev.ctrlKey && k === "-") { ev.preventDefault(); setZoom(S.zoom / 1.2); }
    else if ((k === "delete" || k === "backspace") && !typing && S.selAnnot) {
      ev.preventDefault();
      const pg = S.pageEls[S.selAnnot.page];
      deleteAnnot(pg, { xref: S.selAnnot.xref });
    } else if (k === "escape" && !typing) {
      if (S.placing) { S.placing = null; setTool("edit"); toast("Cancelled.", ""); }
      selectAnnot(null);
    }
  });

  // drag & drop a PDF anywhere
  let depth = 0;
  const isFiles = (ev) => ev.dataTransfer && Array.from(ev.dataTransfer.types || []).includes("Files");
  window.addEventListener("dragenter", (ev) => { if (!isFiles(ev)) return; ev.preventDefault(); depth++; document.body.classList.add("dragging"); });
  window.addEventListener("dragleave", (ev) => { if (!isFiles(ev)) return; if (--depth <= 0) { depth = 0; document.body.classList.remove("dragging"); } });
  window.addEventListener("dragover", (ev) => ev.preventDefault());
  window.addEventListener("drop", (ev) => {
    ev.preventDefault();
    depth = 0;
    document.body.classList.remove("dragging");
    const files = ev.dataTransfer && ev.dataTransfer.files ? Array.from(ev.dataTransfer.files) : [];
    if (files.length) openFiles(files);
  });

  try {
    const saved = localStorage.getItem("kbMode");
    syncKb(saved && saved !== "en" ? "en" : "en");
  } catch (e) { /* ignore */ }
  loadFonts();
  api("/api/state").then((st) => { if (st.open) setDocument(st); }).catch(() => {});
}

init();
