const test = require('node:test');
const assert = require('node:assert');
const {fixMojibake, looksGarbled, decodeStrict} = require('../../lib/mojibake');

// garble: what the old pipeline did (UTF-8 bytes read as Latin-1)
const garble = (s) => Buffer.from(s, 'utf8').toString('latin1');
// garble as cp1252 (bytes 0x80-0x9F shown as €, ™ ...)
const CP = {0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8A: 'Š', 0x8B: '‹', 0x8C: 'Œ',
  0x8E: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9A: 'š', 0x9B: '›', 0x9C: 'œ',
  0x9E: 'ž', 0x9F: 'Ÿ'};
const garble1252 = (s) => Array.from(Buffer.from(s, 'utf8')).map((b) => CP[b] || String.fromCharCode(b)).join('');

const fixed = (input, expected) => {
  const r = fixMojibake(input);
  assert.strictEqual(r.reason, 'fixed', `${JSON.stringify(input)} -> ${r.reason}`);
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.text, expected);
  // idempotent
  const again = fixMojibake(r.text);
  assert.strictEqual(again.text, expected);
  assert.strictEqual(again.changed, false);
};

test('real examples', () => {
  fixed('MÃ¼ller', 'Müller');
  fixed('naÃ¯ve', 'naïve');
  fixed('KÃ¶ster', 'Köster');
  fixed('PeppÃ©', 'Peppé');
  fixed('Ali-ChÃ©rif', 'Ali-Chérif');
  fixed('MÃ¼ller, KÃ¶ster; PeppÃ©', 'Müller, Köster; Peppé');
});

test('C1 control form and cp1252 form of the same bytes', () => {
  fixed('Donâ\u0080\u0099t', 'Don’t');
  fixed('Donâ€™t', 'Don’t');
  fixed(garble1252('“quoted” – dash … ellipsis ™'), '“quoted” – dash … ellipsis ™');
  fixed(garble('“quoted” – dash'), '“quoted” – dash');
});

test('every cp1252 extra maps back', () => {
  for (const b of Object.keys(CP)) {
    // a 3-byte character whose last byte is b: U+2000 block has E2 80 xx ; use E2 + 80 + b only when b is a continuation
    const bytes = Buffer.from([0xE2, 0x80, Number(b)]);
    const text = bytes.toString('utf8');
    const g = garble1252(text);
    fixed(g, text);
  }
});

test('2-, 3- and 4-byte sequences, Cyrillic, CJK, emoji, Greek', () => {
  fixed(garble('Москва'), 'Москва');
  fixed(garble('東京大学'), '東京大学');
  fixed(garble('αβγ δ'), 'αβγ δ');
  fixed(garble('smile 😀 ok'), 'smile 😀 ok');
  fixed(garble1252('smile 😀 ok'), 'smile 😀 ok');
  fixed(garble('€ 100'), '€ 100');
  fixed(garble('\u{1F9E0} brain'), '\u{1F9E0} brain');
  fixed(garble('Ångström and Æther'), 'Ångström and Æther');
});

test('already correct text stays', () => {
  for (const s of ['Müller', 'naïve café', 'Ångström', 'Москва', '東京', 'Don’t', 'smile 😀', 'plain ASCII', 'ñ', '©', 'A × B ± C']) {
    const r = fixMojibake(s);
    assert.deepStrictEqual(r, {text: s, changed: false, reason: 'clean'}, s);
  }
});

test('ASCII, empty, non-strings', () => {
  assert.deepStrictEqual(fixMojibake(''), {text: '', changed: false, reason: 'clean'});
  assert.deepStrictEqual(fixMojibake('abc 123'), {text: 'abc 123', changed: false, reason: 'clean'});
  assert.strictEqual(fixMojibake(null).changed, false);
  assert.strictEqual(fixMojibake(undefined).changed, false);
  assert.strictEqual(fixMojibake(5).changed, false);
});

test('mixed: genuine non-Latin-1 text plus mojibake is left unchanged', () => {
  const s = 'MÃ¼ller and Москва';
  assert.deepStrictEqual(fixMojibake(s), {text: s, changed: false, reason: 'mixed'});
  const t = 'KÃ¶ster “quoted” 東京';
  assert.strictEqual(fixMojibake(t).reason, 'mixed');
  const u = 'MÃ¼ller and Müller'; // genuine ü is the single byte FC: not valid UTF-8
  assert.strictEqual(fixMojibake(u).changed, false);
  assert.strictEqual(fixMojibake(u).text, u);
  assert.strictEqual(fixMojibake(u).reason, 'invalid-utf8');
});

test('invalid UTF-8: truncated, lone continuation, overlong, surrogate, too large', () => {
  for (const s of ['MÃ', 'Ã¼Ã', 'â\u0080', 'Ã(', 'Â\u0080\u0080x', String.fromCharCode(0xC0, 0x80) + 'Â\u0080', 'ð\u0080\u0080\u0080Â\u0080']) {
    const r = fixMojibake(s);
    assert.strictEqual(r.changed, false, JSON.stringify(s));
    assert.strictEqual(r.text, s);
  }
  assert.strictEqual(fixMojibake('MÃ').reason, 'clean', 'a lone lead byte is not a candidate');
  // surrogate encoded in UTF-8 (ED A0 80) and > U+10FFFF (F4 90 80 80)
  assert.strictEqual(decodeStrict([0xED, 0xA0, 0x80]), null);
  assert.strictEqual(decodeStrict([0xF4, 0x90, 0x80, 0x80]), null);
  assert.strictEqual(decodeStrict([0xE0, 0x80, 0x80]), null);
  assert.strictEqual(decodeStrict([0xC0, 0x80]), null);
  assert.strictEqual(decodeStrict([0xC3]), null);
  assert.strictEqual(decodeStrict([0xC3, 0xBC]), 'ü');
  assert.strictEqual(decodeStrict([0xF0, 0x9F, 0x98, 0x80]), '😀');
  assert.strictEqual(fixMojibake('Ã¼Ã').reason, 'invalid-utf8');
});

test('does not touch a garbled-looking pair that is not valid UTF-8 overall', () => {
  // "Â" followed by a continuation-looking char but with a stray genuine Latin-1 char
  const s = 'café Â x'; // é alone (E9) is a lead byte with no continuation
  const r = fixMojibake(s);
  assert.strictEqual(r.changed, false);
});

test('double encoding is repaired one level only', () => {
  const twice = garble(garble('Müller'));
  const once = fixMojibake(twice);
  assert.strictEqual(once.text, garble('Müller'));
  assert.strictEqual(fixMojibake(once.text).text, 'Müller');
});

test('idempotence over many strings', () => {
  const samples = ['MÃ¼ller', 'x', '', 'Москва', garble('日本語 text ñ'), garble1252('naïve – “x”'), 'Donâ\u0080\u0099t', 'MÃ'];
  for (const s of samples) {
    const a = fixMojibake(s).text;
    assert.strictEqual(fixMojibake(a).text, a);
  }
});

test('looksGarbled', () => {
  assert.strictEqual(looksGarbled('Ã¼'), true);
  assert.strictEqual(looksGarbled('â€™'), true);
  assert.strictEqual(looksGarbled('ü'), false);
  assert.strictEqual(looksGarbled('Ã'), false);
  assert.strictEqual(looksGarbled('Ã a'), false);
});
