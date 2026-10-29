const test = require('node:test');
const assert = require('node:assert');
const {repairText, slashesAmbiguous, TRANSFORMS} = require('../../lib/text-repair');

const garble = (s) => Buffer.from(s, 'utf8').toString('latin1');
const only = (name, s, field) => repairText(s, {transforms: [name], field});

test('slashes: examples', () => {
  assert.strictEqual(only('slashes', "Brodmann\\'s area 40").text, "Brodmann's area 40");
  assert.strictEqual(only('slashes', "O\\'Neil").text, "O'Neil");
  assert.strictEqual(only('slashes', '\\"I know\\" to novel').text, '"I know" to novel');
  assert.strictEqual(only('slashes', 'fMRI)\\\\magnetoencephalography').text, 'fMRI)\\magnetoencephalography');
  assert.deepStrictEqual(only('slashes', "a\\'b").applied, ['slashes']);
});

test('slashes: other backslash sequences and no-backslash strings stay', () => {
  for (const s of ['no backslash', '', '\\alpha and \\beta', 'ends with \\', 'LaTeX \\frac{1}{2}', 'tab\\t', 'a\\nb', "it's \"fine\""]) {
    const r = only('slashes', s);
    assert.strictEqual(r.text, s, s);
    assert.deepStrictEqual(r.applied, []);
  }
});

test('slashes: ambiguous layouts are skipped entirely', () => {
  for (const s of ["x \\\\' y", 'x \\\\" y', "x \\\\\\' y", 'x \\\\\\ y', "a\\'b and \\\\'c"]) {
    assert.strictEqual(slashesAmbiguous(s), true, s);
    assert.strictEqual(only('slashes', s).text, s, s);
  }
  assert.strictEqual(slashesAmbiguous("a\\'b \\\\ c"), false);
});

test('slashes: one pass, idempotent', () => {
  for (const s of ["a\\'b", 'x\\\\y', "\\'\\'", '\\"q\\"', 'a\\\\\\\\b'.replace('\\\\\\\\', '\\\\'), 'plain']) {
    const once = only('slashes', s).text;
    assert.strictEqual(only('slashes', once).text, once, s);
  }
  // a double backslash becomes one, and a second run does not eat it
  assert.strictEqual(only('slashes', 'a\\\\b').text, 'a\\b');
  assert.strictEqual(only('slashes', 'a\\b').text, 'a\\b');
});

test('orequals', () => {
  assert.strictEqual(only('orequals', 'p <or= 0.05 and d >or= 2', 'Abstract').text, 'p ≤ 0.05 and d ≥ 2');
  assert.strictEqual(only('orequals', 'a <or=b').text, 'a ≤b');
  assert.deepStrictEqual(only('orequals', 'nothing').applied, []);
  assert.strictEqual(only('orequals', 'p <or= 1', 'Authors').text, 'p <or= 1', 'not applied to Authors');
  assert.strictEqual(only('orequals', 'p <or= 1', 'Experiments[].title').text, 'p <or= 1');
});

test('whitespace on Reference', () => {
  assert.strictEqual(only('whitespace', 'McKinstry RC,   (2007) Neuroimage', 'Reference').text, 'McKinstry RC (2007) Neuroimage');
  assert.strictEqual(only('whitespace', 'A B,(2007) X', 'Reference').text, 'A B (2007) X');
  assert.strictEqual(only('whitespace', '  Smith   J   (2001)   J Neurosci  ', 'Reference').text, 'Smith J (2001) J Neurosci');
  assert.strictEqual(only('whitespace', 'Smith J, Jones K (2001)', 'Reference').text, 'Smith J, Jones K (2001)', 'other commas stay');
  assert.strictEqual(only('whitespace', ' () ', 'Reference').text, '()');
  assert.strictEqual(only('whitespace', '()', 'Reference').text, '()');
  assert.strictEqual(only('whitespace', 'Smith J, (n=5) data', 'Reference').text, 'Smith J, (n=5) data', 'only a 4-digit year group');
});

test('whitespace on the other fields: trim only', () => {
  assert.strictEqual(only('whitespace', '  A   title  ', 'Title').text, 'A   title');
  assert.strictEqual(only('whitespace', 'Smith,   (2007)', 'Authors').text, 'Smith,   (2007)');
  assert.strictEqual(only('whitespace', ' x\n', 'Abstract').text, 'x');
  assert.strictEqual(only('whitespace', ' x ', 'Experiments[].title').text, ' x ', 'not applied to experiments');
});

test('all four defects at once; mojibake runs first', () => {
  const input = garble('Müller RC,  ') + '(2007) ' + garble('naïve') + " O\\'Neil p <or= 0.05  ";
  const r = repairText(input, {field: 'Reference'});
  assert.strictEqual(r.text, "Müller RC (2007) naïve O'Neil p ≤ 0.05");
  assert.deepStrictEqual(r.applied, ['mojibake', 'slashes', 'orequals', 'whitespace']);
  assert.deepStrictEqual(r.steps.map((s) => s.name), TRANSFORMS);
  assert.strictEqual(r.steps[0].before, input);
  assert.strictEqual(r.steps[3].after, r.text);
});

test('order matters: slashes would corrupt the bytes of a garbled string if run first', () => {
  // the byte 0x5C is a backslash in UTF-8 too; a garbled "\\'" inside text must still be fixed after decoding
  const input = garble("é\\'x");
  assert.strictEqual(repairText(input, {field: 'Title'}).text, "é'x");
});

test('--only style selection', () => {
  const s = garble('é') + " \\' p <or= 1 ";
  assert.strictEqual(repairText(s, {transforms: ['mojibake']}).text, "é \\' p <or= 1 ");
  assert.deepStrictEqual(repairText(s, {transforms: ['slashes']}).applied, ['slashes']);
  assert.deepStrictEqual(repairText(s, {transforms: ['orequals', 'mojibake']}).applied, ['mojibake', 'orequals'], 'order is fixed, not the order asked');
  assert.deepStrictEqual(repairText(s, {transforms: []}).applied, []);
});

test('idempotence of the whole pipeline', () => {
  const samples = [
    garble('Müller') + " O\\'Neil <or= 3  ", 'plain', '', '  x  ', 'a\\\\b', "\\\"q\\\"", garble('東京') + ' ,  (1999) z', "x \\\\' y", '()', 'McKinstry RC,   (2007) Neuroimage'
  ];
  for (const s of samples) {
    for (const field of ['Title', 'Authors', 'Abstract', 'Reference', 'Experiments[].title']) {
      const a = repairText(s, {field}).text;
      const b = repairText(a, {field});
      assert.strictEqual(b.text, a, `${JSON.stringify(s)} / ${field}`);
      assert.deepStrictEqual(b.applied, []);
    }
  }
});

test('non-strings and clean strings are returned as is', () => {
  assert.deepStrictEqual(repairText(null).applied, []);
  assert.strictEqual(repairText(5).text, 5);
  assert.deepStrictEqual(repairText('Müller, naïve, “quoted”', {field: 'Title'}).applied, []);
});
