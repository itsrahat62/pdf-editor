/* Bangla typing inside the app: Avro Phonetic and the Bijoy keyboard layout,
   both producing Unicode text. Works in text boxes and in the page editor.
   F12 switches between English and the last Bangla layout. */
"use strict";

const BanglaInput = (() => {
  let mode = "en";
  let lastBangla = "avro";
  const listeners = [];
  const state = new WeakMap();

  // ------------------------------------------------------------ caret access
  /** Text before the caret and a setter that replaces it (null if unsupported). */
  function caret(el) {
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      if (el.selectionStart !== el.selectionEnd) return null;
      const pos = el.selectionStart;
      return {
        before: el.value.slice(0, pos),
        set(nb) {
          el.value = nb + el.value.slice(pos);
          el.selectionStart = el.selectionEnd = nb.length;
          el.dispatchEvent(new Event("input", { bubbles: true }));
        },
      };
    }
    const sel = window.getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) return null;
    let node = sel.anchorNode, off = sel.anchorOffset;
    if (!node || !el.contains(node)) return null;
    if (node.nodeType !== 3) {
      const prev = node.childNodes[off - 1];
      if (prev && prev.nodeType === 3) { node = prev; off = prev.length; }
      else if (prev && prev.nodeType === 1 && prev.lastChild && prev.lastChild.nodeType === 3) {
        node = prev.lastChild; off = node.length;
      } else {
        const host = node.nodeType === 1 && node.querySelector && node.querySelector("span[data-i]");
        const t = document.createTextNode("");
        if (host && node === el && !prev) host.insertBefore(t, host.firstChild);
        else node.insertBefore(t, node.childNodes[off] || null);
        node = t; off = 0;
      }
    }
    const n = node, o = off;
    return {
      before: n.data.slice(0, o),
      set(nb) {
        n.data = nb + n.data.slice(o);
        const r = document.createRange();
        r.setStart(n, nb.length);
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
      },
    };
  }

  // ------------------------------------------------------------------ Avro
  function avroKey(el, ev) {
    const st = state.get(el) || { buf: "", out: "" };
    const k = ev.key;
    if (k === "Backspace") {
      if (!st.buf) return false;
      const c = caret(el);
      if (!c || !c.before.endsWith(st.out)) { state.delete(el); return false; }
      const buf = st.buf.slice(0, -1);
      const out = buf ? OmicronLab.Avro.Phonetic.parse(buf) : "";
      c.set(c.before.slice(0, c.before.length - st.out.length) + out);
      state.set(el, { buf, out });
      return true;
    }
    if (k.length !== 1 || k === " ") { state.delete(el); return false; }
    const c = caret(el);
    if (!c) { state.delete(el); return false; }
    let cur = st;
    if (cur.out && !c.before.endsWith(cur.out)) cur = { buf: "", out: "" };
    const buf = cur.buf + k;
    const out = OmicronLab.Avro.Phonetic.parse(buf);
    c.set(c.before.slice(0, c.before.length - cur.out.length) + out);
    state.set(el, { buf, out });
    return true;
  }

  // ----------------------------------------------------------------- Bijoy
  const BIJOY = {
    "1": "১", "2": "২", "3": "৩", "4": "৪", "5": "৫", "6": "৬", "7": "৭", "8": "৮", "9": "৯", "0": "০",
    q: "ঙ", Q: "ং", w: "য", W: "য়", e: "ড", E: "ঢ", r: "প", R: "ফ", t: "ট", T: "ঠ",
    y: "চ", Y: "ছ", u: "জ", U: "ঝ", i: "হ", I: "ঞ", o: "গ", O: "ঘ", p: "ড়", P: "ঢ়",
    a: "ৃ", A: "র্", s: "ু", S: "ূ", d: "ি", D: "ী", f: "া", F: "অ", g: "্", G: "।",
    h: "ব", H: "ভ", j: "ক", J: "খ", k: "ত", K: "থ", l: "দ", L: "ধ",
    z: "্র", Z: "্য", x: "ও", X: "ৗ", c: "ে", C: "ৈ", v: "র", V: "ল", b: "ন", B: "ণ",
    n: "স", N: "ষ", m: "ম", M: "শ", "\\": "ৎ", "|": "ঃ", "&": "ঁ", "$": "৳",
  };
  const CONS = "কখগঘঙচছজঝঞটঠডঢণতথদধনপফবভমযরলশষসহড়ঢ়য়ৎ";
  const PRE = "িেৈ";
  const FULL = { "ি": "ই", "ী": "ঈ", "ু": "উ", "ূ": "ঊ", "ৃ": "ঋ", "ে": "এ", "ৈ": "ঐ", "া": "আ", "ৗ": "ঔ" };
  const KARS = "ািীুূৃেৈোৌ";

  function bijoyApply(before, m, st) {
    const last = before.slice(-1);
    const isCons = m.length === 1 && CONS.includes(m) || m === "ড়" || m === "ঢ়" || m === "য়";
    const ns = { pre: null, att: null, wait: null, hasant: false };
    // hasant + vowel sign = the independent vowel
    if (st.hasant && last === "্" && FULL[m]) return [before.slice(0, -1) + FULL[m], ns];
    if (PRE.includes(m) && m.length === 1) {
      ns.pre = m;                                   // typed before its consonant
      return [before + m, ns];
    }
    if (isCons) {
      if (st.pre && last === st.pre) { ns.att = st.pre; return [before.slice(0, -1) + m + st.pre, ns]; }
      if (st.wait) { ns.att = st.wait; return [before + m + st.wait, ns]; }
      return [before + m, ns];
    }
    if (m === "্") {
      if (st.att && last === st.att) { ns.wait = st.att; return [before.slice(0, -1) + "্", ns]; }
      ns.hasant = true;
      return [before + "্", ns];
    }
    if (m === "্র" || m === "্য") {
      if (st.att && last === st.att) { ns.att = st.att; return [before.slice(0, -1) + m + st.att, ns]; }
      return [before + m, ns];
    }
    if (m === "া" && st.att === "ে" && last === "ে") return [before.slice(0, -1) + "ো", ns];
    if (m === "ৗ" && st.att === "ে" && last === "ে") return [before.slice(0, -1) + "ৌ", ns];
    if (m === "র্") {
      // reph is typed after the consonant (cluster) it sits on
      const re = new RegExp("((?:[" + CONS + "]্)*[" + CONS + "])([" + KARS + "]*)$");
      const mm = before.match(re);
      if (mm) return [before.slice(0, mm.index) + "র্" + mm[1] + mm[2], ns];
      return [before + "র্", ns];
    }
    return [before + m, ns];
  }

  function bijoyKey(el, ev) {
    const k = ev.key;
    if (k === "Backspace" || k.length !== 1) { state.delete(el); return false; }
    const m = BIJOY[k];
    if (m === undefined) { state.delete(el); return false; }
    const c = caret(el);
    if (!c) return false;
    const st = state.get(el) || { pre: null, att: null, wait: null, hasant: false };
    const [nb, ns] = bijoyApply(c.before, m, st);
    c.set(nb);
    state.set(el, ns);
    return true;
  }

  // ------------------------------------------------------------ dispatching
  function editable(t) {
    if (!t || t.dataset && t.dataset.latin !== undefined) return null;
    if (t.tagName === "TEXTAREA") return t;
    if (t.tagName === "INPUT" && /^(text|search|)$/i.test(t.type)) return t;
    const ce = t.closest && t.closest("[contenteditable=true]");
    return ce || null;
  }

  function onKey(ev) {
    if (ev.key === "F12") {
      ev.preventDefault();
      setMode(mode === "en" ? lastBangla : "en");
      return;
    }
    if (mode === "en" || ev.ctrlKey || ev.altKey || ev.metaKey || ev.isComposing) return;
    const el = editable(ev.target);
    if (!el) return;
    const handled = mode === "avro" ? avroKey(el, ev) : bijoyKey(el, ev);
    if (handled) { ev.preventDefault(); ev.stopPropagation(); }
  }

  function setMode(m) {
    mode = m;
    if (m !== "en") lastBangla = m;
    try { localStorage.setItem("kbMode", m); } catch (e) { /* ignore */ }
    listeners.forEach((f) => f(m));
  }

  document.addEventListener("keydown", onKey, true);
  document.addEventListener("mousedown", () => { /* caret moves: start fresh words */ }, true);
  try {
    const saved = localStorage.getItem("kbMode");
    if (saved === "avro" || saved === "bijoy") { lastBangla = saved; }
  } catch (e) { /* ignore */ }

  return {
    get mode() { return mode; },
    setMode,
    onChange(f) { listeners.push(f); },
    _bijoyApply: bijoyApply,
  };
})();
