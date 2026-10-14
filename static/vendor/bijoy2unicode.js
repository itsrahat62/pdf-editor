/* bijoy2unicode 1.0.2 — https://github.com/JehadurRE/Bijoy2Unicode
   MIT License
   
   Copyright (c) 2026 Md. Jehad (Jehadur Rahman Emran)
   
   Permission is hereby granted, free of charge, to any person obtaining a copy
   of this software and associated documentation files (the "Software"), to deal
   in the Software without restriction, including without limitation the rights
   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
   copies of the Software, and to permit persons to whom the Software is
   furnished to do so, subject to the following conditions:
   
   The above copyright notice and this permission notice shall be included in all
   copies or substantial portions of the Software.
   
   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
   SOFTWARE.
   
   This is an original implementation in TypeScript with significant additions
   and corrections, including (but not limited to):
     - Trailing reph reorder (handles `Kg©KZ©vi` → কর্মকর্তার end-of-syllable case)
     - `Í` (U+00CD) Sutonny MJ alternate mapping for ন্ত / স্ত / ক্ত conjuncts
     - Multi-character sequence handling (`iæ → রু`, `Mø → গ্ল`, etc.)
     - `ÿ → ক্ষ` alternate Sutonny MJ encoding
     - Precomposed nukta letters (ড়/ঢ়/য়) preserved per Word/Office convention
     - Font-aware detection across run / paragraph / style / docDefaults
   
   Inspired by prior open-source Bijoy converters, notably:
     - Mad-FOX/bijoy2unicode (Python)
     - bnwebtools / nishiafia/bijoytounicodeconverter (PHP/JS)
   (Wrapped as a browser global for PDF Editor; code otherwise unchanged.) */
(function () {
// src/core.ts
var buildMap = (raw) => Object.entries(raw).map(([k, v]) => [
  new RegExp(escapeForRegex(k), "g"),
  v
]);
function escapeForRegex(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
var preConversionMap = buildMap({
  "  ": " ",
  yy: "y",
  vv: "v",
  "\xAD\xAD": "\xAD",
  "y&": "y",
  "\u201E&": "\u201E",
  "\u2021u": "u\u2021",
  wu: "uw",
  " ,": ",",
  " |": "|",
  "\\ ": "",
  " \\": "",
  "\\": "",
  "\n ": "\n",
  " \n": "\n",
  "\n\n\n\n\n": "\n\n",
  "\n\n\n\n": "\n\n",
  "\n\n\n": "\n\n"
});
var conversionMap = buildMap({
  // ---- Multi-character sequences first ----
  // These must run before the single-byte mappings below, otherwise the
  // single-byte mapping on the second char of a sequence would consume
  // it (e.g. `iæ` → `রু` must match before `æ` → `ু`).
  // Some entries are inherited from earlier converters; many are original
  // additions for real-world Sutonny MJ documents.
  "i\xE6": "\u09B0\u09C1",
  "i\u201C": "\u09B0\u09C1",
  // ru with smart-quote variant
  "i\u0192": "\u09B0\u09C2",
  // rū
  "M\xF8": "\u0997\u09CD\u09B2",
  "\u201DQ\xA6": "\u099A\u09CD\u099B\u09CD\u09AC",
  "c\xF8": "\u09AA\u09CD\u09B2",
  "e\xF8": "\u09AC\u09CD\u09B2",
  "k\xF8": "\u09B6\u09CD\u09B2",
  "\xA4\xF8": "\u09AE\u09CD\u09B2",
  "\xAF\xF8": "\u09B8\u09CD\u09B2",
  "\xE5\u201C": "\u09AD\u09CD\u09B0\u09C1",
  // 'Í' (U+00CD) is a Sutonny MJ alternate for '—' (em-dash) used in
  // ন্ত / স্ত / ক্ত style conjuncts. Map every prefix-pair first, then the
  // remaining bare 'Í' falls through to the single-byte map below.
  "\xAF\xCD": "\u09B8\u09CD\u09A4",
  // ¯Í -> স্ত
  "\u0161\xCD": "\u09A8\u09CD\u09A4",
  // šÍ -> ন্ত
  "\xAF\xCD\xA1": "\u09B8\u09CD\u09A4\u09CD\u09AC",
  // ¯Í¡ -> স্ত্ব
  "\u0161\xCD\xA1": "\u09A8\u09CD\u09A4\u09CD\u09AC",
  // šÍ¡ -> ন্ত্ব
  "\xCB\xA1": "\u09A4\u09CD\u09A4\u09CD\u09AC",
  // Ë¡ overrides the single-byte Ë mapping
  "\\\\": "\u0965",
  // ---- Vowels (Av must come before A) ----
  Av: "\u0986",
  A: "\u0985",
  B: "\u0987",
  C: "\u0988",
  D: "\u0989",
  E: "\u098A",
  F: "\u098B",
  G: "\u098F",
  H: "\u0990",
  I: "\u0993",
  J: "\u0994",
  // Consonants
  K: "\u0995",
  L: "\u0996",
  M: "\u0997",
  N: "\u0998",
  O: "\u0999",
  P: "\u099A",
  Q: "\u099B",
  R: "\u099C",
  S: "\u099D",
  T: "\u099E",
  U: "\u099F",
  V: "\u09A0",
  W: "\u09A1",
  X: "\u09A2",
  Y: "\u09A3",
  Z: "\u09A4",
  _: "\u09A5",
  "`": "\u09A6",
  a: "\u09A7",
  b: "\u09A8",
  c: "\u09AA",
  d: "\u09AB",
  e: "\u09AC",
  f: "\u09AD",
  g: "\u09AE",
  h: "\u09AF",
  i: "\u09B0",
  j: "\u09B2",
  k: "\u09B6",
  l: "\u09B7",
  m: "\u09B8",
  n: "\u09B9",
  o: "\u09DC",
  // ড় (precomposed)
  p: "\u09DD",
  // ঢ় (precomposed)
  q: "\u09DF",
  // য় (precomposed)
  r: "\u09CE",
  s: "\u0982",
  t: "\u0983",
  u: "\u0981",
  // Numbers
  "0": "\u09E6",
  "1": "\u09E7",
  "2": "\u09E8",
  "3": "\u09E9",
  "4": "\u09EA",
  "5": "\u09EB",
  "6": "\u09EC",
  "7": "\u09ED",
  "8": "\u09EE",
  "9": "\u09EF",
  // Kars
  "\u2022": "\u0999\u09CD",
  v: "\u09BE",
  w: "\u09BF",
  x: "\u09C0",
  y: "\u09C1",
  z: "\u09C1",
  "\u201C": "\u09C1",
  "\u2013": "\u09C1",
  "~": "\u09C2",
  "\u0192": "\u09C2",
  "\u201A": "\u09C2",
  "\u201E\u201E": "\u09C3",
  "\u201E": "\u09C3",
  "\u2026": "\u09C3",
  "\u2020": "\u09C7",
  "\u2021": "\u09C7",
  "\u02C6": "\u09C8",
  "\u2030": "\u09C8",
  "\u0160": "\u09D7",
  "|": "\u0964",
  "&": "\u09CD\u200C",
  // Conjuncts
  "^": "\u09CD\u09AC",
  "\u2018": "\u09CD\u09A4\u09C1",
  "\u2019": "\u09CD\u09A5",
  "\u2039": "\u09CD\u0995",
  "\u0152": "\u09CD\u0995\u09CD\u09B0",
  "\u201D": "\u099A\u09CD",
  "\u2014": "\u09CD\u09A4",
  "\u02DC": "\u09A6\u09CD",
  "\u2122": "\u09A6\u09CD",
  "\u0161": "\u09A8\u09CD",
  "\u203A": "\u09A8\u09CD",
  "\u0153": "\u09CD\u09A8",
  "\u0178": "\u09CD\u09AC",
  "\xA1": "\u09CD\u09AC",
  "\xA2": "\u09CD\u09AD",
  "\xA3": "\u09CD\u09AD\u09CD\u09B0",
  "\xA4": "\u09AE\u09CD",
  "\xA5": "\u09CD\u09AE",
  "\xA6": "\u09CD\u09AC",
  "\xA7": "\u09CD\u09AE",
  "\xA8": "\u09CD\u09AF",
  "\xA9": "\u09B0\u09CD",
  "\xAA": "\u09CD\u09B0",
  "\xAB": "\u09CD\u09B0",
  "\xAC": "\u09CD\u09B2",
  "\xAD": "\u09CD\u09B2",
  "\xAE": "\u09B7\u09CD",
  "\xAF": "\u09B8\u09CD",
  "\xB0": "\u0995\u09CD\u0995",
  "\xB1": "\u0995\u09CD\u099F",
  "\xB2": "\u0995\u09CD\u09B7\u09CD\u09A3",
  "\xB3": "\u0995\u09CD\u09A4",
  "\xB4": "\u0995\u09CD\u09AE",
  "\xB5": "\u0995\u09CD\u09B0",
  "\xB6": "\u0995\u09CD\u09B7",
  "\xB7": "\u0995\u09CD\u09B8",
  "\xB8": "\u0997\u09C1",
  "\xB9": "\u099C\u09CD\u099E",
  "\xBA": "\u0997\u09CD\u09A6",
  "\xBB": "\u0997\u09CD\u09A7",
  "\xBC": "\u0999\u09CD\u0995",
  "\xBD": "\u0999\u09CD\u0997",
  "\xBE": "\u099C\u09CD\u099C",
  "\xBF": "\u09CD\u09A4\u09CD\u09B0",
  "\xC0": "\u099C\u09CD\u099D",
  "\xC1": "\u099C\u09CD\u099E",
  "\xC2": "\u099E\u09CD\u099A",
  "\xC3": "\u099E\u09CD\u099B",
  "\xC4": "\u099E\u09CD\u099C",
  "\xC5": "\u099E\u09CD\u099D",
  "\xC6": "\u099F\u09CD\u099F",
  "\xC7": "\u09A1\u09CD\u09A1",
  "\xC8": "\u09A3\u09CD\u099F",
  "\xC9": "\u09A3\u09CD\u09A0",
  "\xCA": "\u09A3\u09CD\u09A1",
  "\xCB": "\u09A4\u09CD\u09A4",
  "\xCC": "\u09A4\u09CD\u09A5",
  "\xCD": "\u09A4\u09CD\u09AE",
  "\xCE": "\u09A4\u09CD\u09B0",
  "\xCF": "\u09A6\u09CD\u09A6",
  "\xD0": "-",
  "\xD1": "-",
  "\xD2": '"',
  "\xD3": '"',
  "\xD4": "'",
  "\xD5": "'",
  "\xD6": "\u09CD\u09B0",
  "\xD7": "\u09A6\u09CD\u09A7",
  "\xD8": "\u09A6\u09CD\u09AC",
  "\xD9": "\u09A6\u09CD\u09AE",
  "\xDA": "\u09A8\u09CD\u09A0",
  "\xDB": "\u09A8\u09CD\u09A1",
  "\xDC": "\u09A8\u09CD\u09A7",
  "\xDD": "\u09A8\u09CD\u09B8",
  "\xDE": "\u09AA\u09CD\u099F",
  "\xDF": "\u09AA\u09CD\u09A4",
  "\xE0": "\u09AA\u09CD\u09AA",
  "\xE1": "\u09AA\u09CD\u09B8",
  "\xE2": "\u09AC\u09CD\u099C",
  "\xE3": "\u09AC\u09CD\u09A6",
  "\xE4": "\u09AC\u09CD\u09A7",
  "\xE5": "\u09AD\u09CD\u09B0",
  "\xE6": "\u09C1",
  // æ — u-kar variant (matches Sutonny MJ usage and bnwebtools).
  // The rare ম্ন conjunct uses other byte sequences (e.g. gœ).
  "\xE7": "\u09AE\u09CD\u09AB",
  "\xE8": "\u09CD\u09A8",
  "\xE9": "\u09B2\u09CD\u0995",
  "\xEA": "\u09B2\u09CD\u0997",
  "\xEB": "\u09B2\u09CD\u099F",
  "\xEC": "\u09B2\u09CD\u09A1",
  "\xED": "\u09B2\u09CD\u09AA",
  "\xEE": "\u09B2\u09CD\u09AB",
  "\xEF": "\u09B6\u09C1",
  "\xF0": "\u09B6\u09CD\u099A",
  "\xF1": "\u09B6\u09CD\u099B",
  "\xF2": "\u09B7\u09CD\u09A3",
  "\xF3": "\u09B7\u09CD\u099F",
  "\xF4": "\u09B7\u09CD\u09A0",
  "\xF5": "\u09B7\u09CD\u09AB",
  "\xF6": "\u09B8\u09CD\u0996",
  "\xF7": "\u09B8\u09CD\u099F",
  "\xF8": "\u09B8\u09CD\u09A8",
  "\xF9": "\u09B8\u09CD\u09AB",
  "\xFA": "\u09CD\u09AA",
  "\xFB": "\u09B9\u09C1",
  "\xFC": "\u09B9\u09C3",
  "\xFD": "\u09B9\u09CD\u09A8",
  "\xFE": "\u09B9\u09CD\u09AE",
  // ---- Additional real-world Bijoy / Sutonny MJ encodings (alternate `ÿ`,
  // etc.). Single-byte additions only — multi-char sequences are at the top
  // of this map.
  "\xFF": "\u0995\u09CD\u09B7"
  // ÿ alternate code for ক্ষ (kkho)
});
var proConversionMap = buildMap({
  "\u09CD\u09CD": "\u09CD"
});
var postConversionMap = buildMap({
  "\u09E6\u0983": "\u09E6:",
  "\u09E7\u0983": "\u09E7:",
  "\u09E8\u0983": "\u09E8:",
  "\u09E9\u0983": "\u09E9:",
  "\u09EA\u0983": "\u09EA:",
  "\u09EB\u0983": "\u09EB:",
  "\u09EC\u0983": "\u09EC:",
  "\u09ED\u0983": "\u09ED:",
  "\u09EE\u0983": "\u09EE:",
  "\u09EF\u0983": "\u09EF:",
  " \u0983": ":",
  "\n\u0983": "\n:",
  "]\u0983": "]:",
  "[\u0983": "[:",
  "  ": " ",
  "\u0985\u09BE": "\u0986",
  "\u09CD\u200C\u09CD\u200C": "\u09CD\u200C"
});
function applyMap(text, map) {
  let out = text;
  for (const [pattern, replacement] of map) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
var HALANT = "\u09CD";
function isBanglaPreKar(c) {
  return c === "\u09BF" || c === "\u09C8" || c === "\u09C7";
}
function isBanglaPostKar(c) {
  return c === "\u09BE" || c === "\u09CB" || c === "\u09CC" || c === "\u09D7" || c === "\u09C1" || c === "\u09C2" || c === "\u09C0" || c === "\u09C3";
}
function isBanglaKar(c) {
  return isBanglaPreKar(c) || isBanglaPostKar(c);
}
function isBanglaBanjonborno(c) {
  if (!c) return false;
  return "\u0995\u0996\u0997\u0998\u0999\u099A\u099B\u099C\u099D\u099E\u099F\u09A0\u09A1\u09A2\u09A3\u09A4\u09A5\u09A6\u09A7\u09A8\u09AA\u09AB\u09AC\u09AD\u09AE\u09AF\u09B0\u09B2\u09B6\u09B7\u09B8\u09B9".includes(c) || c === "\u09A1\u09BC" || // U+09DC
  c === "\u09A2\u09BC" || // U+09DD
  c === "\u09AF\u09BC" || // U+09DF
  c === "\u09CE" || c === "\u0982" || c === "\u0983" || c === "\u0981";
}
function isBanglaNukta(c) {
  return c === "\u0981";
}
function isBanglaHalant(c) {
  return c === HALANT;
}
function isSpace(c) {
  return c === " " || c === "	" || c === "\n" || c === "\r";
}
function charAt(s, i) {
  if (i < 0 || i >= s.length) return "";
  return s.charAt(i);
}
function rearrange(input) {
  let str = input;
  let i = 0;
  while (i < str.length) {
    if (i < str.length - 1 && charAt(str, i) === "\u09B0" && isBanglaHalant(charAt(str, i + 1)) && isBanglaHalant(charAt(str, i - 1))) {
      let j = 1;
      while (true) {
        if (i - j < 0) break;
        if (isBanglaBanjonborno(charAt(str, i - j)) && isBanglaHalant(charAt(str, i - j - 1))) {
          j += 2;
        } else if (j === 1 && isBanglaKar(charAt(str, i - j))) {
          j += 1;
        } else {
          break;
        }
      }
      str = str.slice(0, i - j) + charAt(str, i) + charAt(str, i + 1) + str.slice(i - j, i) + str.slice(i + 2);
      i += 1;
      continue;
    }
    i += 1;
  }
  i = 0;
  while (i < str.length - 1) {
    if (charAt(str, i) === "\u09B0" && isBanglaHalant(charAt(str, i + 1)) && i > 0 && // Previous char must be a banjonborno that does NOT itself form a
    // halanted conjunct head (otherwise it's `র + ্ + halant` and the
    // first pass already handled it).
    isBanglaBanjonborno(charAt(str, i - 1)) && !isBanglaHalant(charAt(str, i - 2)) && // The reph must be at end of cluster — meaning the next char after
    // the halant must NOT be the start of a new halanted conjunct.
    // Specifically, block only if (i+2, i+3) is consonant + halant —
    // that pattern means the reph is genuinely in the middle of a
    // multi-consonant cluster and should be left alone.
    !(isBanglaBanjonborno(charAt(str, i + 2)) && isBanglaHalant(charAt(str, i + 3)))) {
      let j = 1;
      while (true) {
        if (i - j - 1 < 0) break;
        if (isBanglaBanjonborno(charAt(str, i - j - 1)) && isBanglaHalant(charAt(str, i - j))) {
          j += 2;
        } else {
          break;
        }
      }
      str = str.slice(0, i - j) + charAt(str, i) + // র
      charAt(str, i + 1) + // halant
      str.slice(i - j, i) + // the cluster
      str.slice(i + 2);
      i += 2;
      continue;
    }
    i += 1;
  }
  str = applyMap(str, proConversionMap);
  i = 0;
  while (i < str.length) {
    if (i < str.length - 1 && charAt(str, i) === "\u09B0" && isBanglaHalant(charAt(str, i + 1)) && !isBanglaHalant(charAt(str, i - 1)) && isBanglaHalant(charAt(str, i + 2))) {
      let j = 1;
      while (true) {
        if (i - j < 0) break;
        if (isBanglaBanjonborno(charAt(str, i - j)) && isBanglaHalant(charAt(str, i - j - 1))) {
          j += 2;
        } else if (j === 1 && isBanglaKar(charAt(str, i - j))) {
          j += 1;
        } else {
          break;
        }
      }
      str = str.slice(0, i - j) + charAt(str, i) + charAt(str, i + 1) + str.slice(i - j, i) + str.slice(i + 2);
      i += 1;
      continue;
    }
    if (i > 0 && charAt(str, i) === HALANT && (isBanglaKar(charAt(str, i - 1)) || isBanglaNukta(charAt(str, i - 1))) && i < str.length - 1) {
      str = str.slice(0, i - 1) + charAt(str, i) + charAt(str, i + 1) + charAt(str, i - 1) + str.slice(i + 2);
    }
    if (i > 0 && i < str.length - 1 && charAt(str, i) === HALANT && charAt(str, i - 1) === "\u09B0" && charAt(str, i - 2) !== HALANT && isBanglaKar(charAt(str, i + 1))) {
      str = str.slice(0, i - 1) + charAt(str, i + 1) + charAt(str, i - 1) + charAt(str, i) + str.slice(i + 2);
    }
    if (i < str.length - 1 && isBanglaPreKar(charAt(str, i)) && !isSpace(charAt(str, i + 1))) {
      let temp = str.slice(0, i);
      let j = 1;
      while (i + j < str.length - 1 && isBanglaBanjonborno(charAt(str, i + j))) {
        if (i + j < str.length && isBanglaHalant(charAt(str, i + j + 1))) {
          j += 2;
        } else {
          break;
        }
      }
      temp += str.slice(i + 1, i + j + 1);
      let l = 0;
      if (charAt(str, i) === "\u09C7" && charAt(str, i + j + 1) === "\u09BE") {
        temp += "\u09CB";
        l = 1;
      } else if (charAt(str, i) === "\u09C7" && charAt(str, i + j + 1) === "\u09D7") {
        temp += "\u09CC";
        l = 1;
      } else {
        temp += charAt(str, i);
      }
      temp += str.slice(i + j + l + 1);
      str = temp;
      i += j;
    }
    if (i < str.length - 1 && isBanglaNukta(charAt(str, i)) && isBanglaPostKar(charAt(str, i + 1))) {
      str = str.slice(0, i) + charAt(str, i + 1) + charAt(str, i) + str.slice(i + 2);
    }
    i += 1;
  }
  return str;
}
function convertBijoyToUnicode(src) {
  if (!src) return src;
  let out = applyMap(src, preConversionMap);
  out = applyMap(out, conversionMap);
  out = rearrange(out);
  out = applyMap(out, postConversionMap);
  return out;
}
function scanUnmapped(unicodeText) {
  const out = /* @__PURE__ */ new Map();
  if (!unicodeText) return out;
  for (const ch of unicodeText) {
    if (isSuspiciousLeftover(ch)) {
      out.set(ch, (out.get(ch) ?? 0) + 1);
    }
  }
  return out;
}
function isSuspiciousLeftover(ch) {
  const code = ch.codePointAt(0);
  if (code >= 2432 && code <= 2559) return false;
  if (code >= 32 && code <= 126) return false;
  if (code === 9 || code === 10 || code === 13) return false;
  if (code === 8204 || code === 8205) return false;
  if (code === 2404 || code === 2405) return false;
  if (code >= 128 && code <= 591) return true;
  if (code >= 8208 && code <= 8250) return true;
  if (code === 338 || code === 339 || code === 352 || code === 353) return true;
  return false;
}
function describeCodepoint(ch) {
  const cp = ch.codePointAt(0);
  return "U+" + cp.toString(16).toUpperCase().padStart(4, "0");
}
function looksLikeBijoy(text) {
  if (!text) return false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 128 && code <= 591) return true;
    if (code >= 8208 && code <= 8250) return true;
  }
  return false;
}
function hasBengaliUnicode(text) {
  if (!text) return false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 2432 && code <= 2559) return true;
  }
  return false;
}
function shouldConvertAsBijoy(text, fontIsBijoy) {
  if (!text) return false;
  if (fontIsBijoy === true) return true;
  if (fontIsBijoy === false) return false;
  if (hasBengaliUnicode(text)) return false;
  return looksLikeBijoy(text);
}

window.Bijoy2Unicode = { convertBijoyToUnicode, looksLikeBijoy, hasBengaliUnicode, shouldConvertAsBijoy, conversionMap };
})();
