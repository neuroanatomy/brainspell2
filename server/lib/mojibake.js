// Repair of "UTF-8 read as Latin-1" text (mojibake): "MÃ¼ller" -> "Müller".
// Pure, no dependencies, Node 16 compatible.

// cp1252 characters that live in 0x80-0x9F (the five undefined bytes are read as C1 controls
// U+0081 etc., which are <= 0xFF and therefore map to themselves).
const CP1252 = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86,
  '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8A, '‹': 0x8B, 'Œ': 0x8C,
  'Ž': 0x8E, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95,
  '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9A, '›': 0x9B,
  'œ': 0x9C, 'ž': 0x9E, 'Ÿ': 0x9F
};

// Byte value of a character in the Latin-1/cp1252 view, or -1.
function byteOf(ch) {
  const c = ch.charCodeAt(0);
  if (c <= 0xFF) {
    return c;
  }
  const b = CP1252[ch];

  return b === undefined ? -1 : b;
}

// A UTF-8 lead byte (C2..F4) followed by a continuation byte (80..BF), in the Latin-1 view.
function looksGarbled(s) {
  for (let i = 0; i + 1 < s.length; i++) {
    const a = byteOf(s[i]);
    if (a >= 0xC2 && a <= 0xF4) {
      const b = byteOf(s[i + 1]);
      if (b >= 0x80 && b <= 0xBF) {
        return true;
      }
    }
  }

  return false;
}

// Strict UTF-8 decoder: null on any invalid sequence (overlong, surrogate, > U+10FFFF, truncated).
function decodeStrict(bytes) {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i += 1;
      continue;
    }
    let need;
    let cp;
    let min;
    if (b >= 0xC2 && b <= 0xDF) {
      need = 1; cp = b & 0x1F; min = 0x80;
    } else if (b >= 0xE0 && b <= 0xEF) {
      need = 2; cp = b & 0x0F; min = 0x800;
    } else if (b >= 0xF0 && b <= 0xF4) {
      need = 3; cp = b & 0x07; min = 0x10000;
    } else {
      return null;
    }
    for (let k = 1; k <= need; k++) {
      const c = bytes[i + k];
      if (c === undefined || (c & 0xC0) !== 0x80) {
        return null;
      }
      cp = (cp << 6) | (c & 0x3F);
    }
    if (cp < min || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) {
      return null;
    }
    out += String.fromCodePoint(cp);
    i += need + 1;
  }

  return out;
}

/**
 * Repair a UTF-8-read-as-Latin-1 string.
 * @param {string} str Input
 * @returns {{text: string, changed: boolean, reason: "fixed"|"clean"|"mixed"|"invalid-utf8"}}
 *   clean: nothing looks garbled; mixed: garbled-looking but contains characters that cannot
 *   come from a Latin-1 reading (genuine text mixed with mojibake); invalid-utf8: the bytes are
 *   not valid UTF-8 (truncated sequence, or genuine Latin-1 text mixed in). text is the input
 *   unless reason is "fixed".
 */
function fixMojibake(str) {
  if (typeof str !== 'string' || !looksGarbled(str)) {
    return {text: str, changed: false, reason: 'clean'};
  }
  const bytes = new Array(str.length);
  for (let i = 0; i < str.length; i++) {
    const b = byteOf(str[i]);
    if (b < 0) {
      return {text: str, changed: false, reason: 'mixed'};
    }
    bytes[i] = b;
  }
  const text = decodeStrict(bytes);
  if (text === null) {
    return {text: str, changed: false, reason: 'invalid-utf8'};
  }
  if (text.indexOf('�') !== -1 || text === str) {
    return {text: str, changed: false, reason: 'invalid-utf8'};
  }

  return {text, changed: true, reason: 'fixed'};
}

module.exports = {fixMojibake, looksGarbled, decodeStrict};
