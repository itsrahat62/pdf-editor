/* Bijoy (SutonnyMJ-style ANSI) support.
   Old Bangla PDFs store text in "ANSI" fonts such as SutonnyMJ, where Latin
   code points draw Bangla letters. The editor shows such text as Unicode
   (Bijoy2Unicode) and turns what you type back into the ANSI encoding so it is
   written with the same font. */
"use strict";

const BijoyAnsi = (() => {
  const B2U = window.Bijoy2Unicode;
  const CONS = "ক-নপ-রলশ-হড়ঢ়য়ৎ";
  const REPH = "";
  // preferred spelling where several ANSI codes give the same letters
  const PREF = {
    "ু": "y", "ূ": "~", "ৃ": "„", "ে": "‡", "ৈ": "ˆ", "ৗ": "Š", "্": "&", "্র": "Ö", "্ব": "¡", "্য": "¨",
    "্ল": "¬", "্ম": "¥", "্ন": "œ", "্ত": "—", "্থ": "’", "্ক": "‹", "্প": "ú", "্ভ": "¢", "ক্ষ": "ÿ",
    "ঙ্": "•", "চ্": "”", "দ্": "˜", "ন্": "š", "ম্": "¤", "ষ্": "®", "স্": "¯", "।": "|", "ং": "s",
    "ৎ": "r", "আ": "Av", [REPH]: "©",
  };
  const rev = new Map();
  let maxLen = 1;
  if (B2U) {
    for (const [re, val] of B2U.conversionMap) {
      const key = re.source.replace(/\\(.)/g, "$1");
      if (!/[ঀ-৿]/.test(val) || /‌/.test(val)) continue;
      if (!rev.has(val)) rev.set(val, key);
    }
  }
  for (const [k, v] of Object.entries(PREF)) rev.set(k, v);
  for (const k of rev.keys()) maxLen = Math.max(maxLen, k.length);

  const clusterRe = new RegExp("(র্(?=[" + CONS + "]))?((?:[" + CONS + "]্)*[" + CONS + "])([িেৈোৌ])?", "g");

  function toAnsi(text) {
    if (!text) return text;
    let s = text.replace(/ড়/g, "ড়").replace(/ঢ়/g, "ঢ়").replace(/য়/g, "য়").replace(/‌|‍/g, "");
    // Bijoy order: pre-base vowel signs before the consonant cluster, reph after it
    s = s.replace(clusterRe, (m, reph, cluster, kar) => {
      let pre = "", post = "";
      if (kar === "ো") { pre = "ে"; post = "া"; }
      else if (kar === "ৌ") { pre = "ে"; post = "ৗ"; }
      else if (kar) pre = kar;
      return pre + cluster + (reph ? REPH : "") + post;
    });
    let out = "";
    for (let i = 0; i < s.length;) {
      let done = false;
      for (let n = Math.min(maxLen, s.length - i); n > 0; n--) {
        const seq = s.substr(i, n);
        if (rev.has(seq)) { out += rev.get(seq); i += n; done = true; break; }
      }
      if (!done) { out += s[i]; i += 1; }
    }
    return out;
  }

  function toUnicode(text) { return B2U ? B2U.convertBijoyToUnicode(text) : text; }

  /** Does this PDF font name look like an ANSI (Bijoy) Bangla font? */
  function isAnsiFont(name) {
    const n = String(name || "").replace(/^[A-Z]{6}\+/, "").replace(/[-, ]*(Bold|Italic|BoldItalic|Regular)$/i, "");
    if (/OMJ$/i.test(n)) return false;
    return /MJ$/i.test(n) || /ANSI/i.test(n) || /^(Sutonny|Bijoy|Boishakhi|Nikosh ANSI)/i.test(n);
  }

  return { toAnsi, toUnicode, isAnsiFont };
})();
