// PubMed E-utilities client for addArticle (plan, sections 3.7 and 4.3). The record is
// fetched by the SERVER; all text is untrusted and is returned as plain strings.
// PUBMED_URL overrides the efetch URL (used by the tests). At most 2 requests per second.

const http = require('http');
const https = require('https');
const {URL} = require('url');
const xml2js = require('xml2js');
const {fail, CODES} = require('./errors');

const DEFAULT_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi';
const TIMEOUT_MS = 15000;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_MESH = 300;

let minGapMs = 500;
let nextSlot = 0;

function efetchUrl(pmid) {
  const url = new URL(process.env.PUBMED_URL || DEFAULT_URL);
  url.searchParams.set('db', 'pubmed');
  url.searchParams.set('id', pmid);
  url.searchParams.set('retmode', 'xml');
  url.searchParams.set('tool', 'brainspell');

  return url;
}

// Global limiter: one request every minGapMs, in arrival order.
async function throttle() {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + minGapMs;
  if (at > now) {
    await new Promise((r) => setTimeout(r, at - now));
  }
}

function get(url) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'http:' ? http : https;
    const req = lib.request(url, {method: 'GET', headers: {'User-Agent': 'brainspell', Accept: 'application/xml'}, timeout: TIMEOUT_MS}, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES) {
          req.destroy(new Error('response too large'));

          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve({status: res.statusCode, body: Buffer.concat(chunks).toString('utf8')}));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

function parseXml(xml) {
  return new Promise((resolve, reject) => {
    xml2js.parseString(xml, {
      explicitChildren: true, preserveChildrenOrder: true, charsAsChildren: true,
      includeWhiteChars: true, explicitArray: true, trim: false, normalize: false
    }, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

// ---- tree helpers (node: {$: attrs, $$: ordered children, '#name', _ text}) ----

function kids(node, name) {
  return node && Array.isArray(node.$$) ? node.$$.filter((c) => c['#name'] === name) : [];
}

function kid(node, name) {
  return kids(node, name)[0] || null;
}

function path(node, names) {
  let cur = node;
  for (const n of names) {
    cur = kid(cur, n);
    if (!cur) {
      return null;
    }
  }

  return cur;
}

// All the text below a node, in document order (inline markup such as <i> is dropped).
function textOf(node) {
  if (!node) {
    return '';
  }
  if (node['#name'] === '__text__') {
    return typeof node._ === 'string' ? node._ : '';
  }
  if (Array.isArray(node.$$)) {
    return node.$$.map(textOf).join('');
  }

  return typeof node._ === 'string' ? node._ : '';
}

function clean(s, max) {
  const t = String(s).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().normalize('NFC');

  return Array.from(t).slice(0, max).join('');
}

function attr(node, name) {
  return node && node.$ && typeof node.$[name] === 'string' ? node.$[name] : '';
}

function authorsOf(article) {
  const list = path(article, ['AuthorList']);

  return kids(list, 'Author').map((a) => {
    const collective = clean(textOf(kid(a, 'CollectiveName')), 200);
    if (collective) {
      return collective;
    }
    const last = clean(textOf(kid(a, 'LastName')), 100);
    const initials = clean(textOf(kid(a, 'Initials')), 20);

    return `${last} ${initials}`.trim();
  }).filter(Boolean);
}

function yearOf(article) {
  const issue = path(article, ['Journal', 'JournalIssue']);
  const year = clean(textOf(path(issue, ['PubDate', 'Year'])), 4);
  if (/^\d{4}$/.test(year)) {
    return year;
  }
  const m = /\d{4}/.exec(textOf(path(issue, ['PubDate', 'MedlineDate'])));
  if (m) {
    return m[0];
  }
  const ad = clean(textOf(path(article, ['ArticleDate', 'Year'])), 4);

  return /^\d{4}$/.test(ad) ? ad : '';
}

function referenceOf(article, authors) {
  const issue = path(article, ['Journal', 'JournalIssue']);
  const journal = clean(textOf(path(article, ['Journal', 'ISOAbbreviation'])) ||
    textOf(path(article, ['Journal', 'Title'])), 200);
  const volume = clean(textOf(kid(issue, 'Volume')), 50);
  const iss = clean(textOf(kid(issue, 'Issue')), 50);
  const pages = clean(textOf(path(article, ['Pagination', 'MedlinePgn'])), 50);
  const who = authors.length > 5 ? `${authors.slice(0, 5).join(', ')} et al.` : authors.join(', ');
  const year = yearOf(article);
  let ref = who;
  if (year) {
    ref += `${ref ? ' ' : ''}(${year})`;
  }
  if (journal) {
    ref += `${ref ? ' ' : ''}${journal}`;
  }
  if (volume) {
    ref += ` ${volume}${iss ? `(${iss})` : ''}`;
  }
  if (pages) {
    ref += `${volume || iss ? ':' : ' '}${pages}`;
  }

  return clean(ref, 1000);
}

function doiOf(pubmedData, article) {
  const candidates = [];
  kids(path(pubmedData, ['ArticleIdList']), 'ArticleId').forEach((n) => {
    if (attr(n, 'IdType') === 'doi') {
      candidates.push(textOf(n));
    }
  });
  kids(article, 'ELocationID').forEach((n) => {
    if (attr(n, 'EIdType') === 'doi') {
      candidates.push(textOf(n));
    }
  });
  const doi = candidates.map((c) => clean(c, 200)).find((c) => /^10\.\d{4,9}\/\S+$/.test(c));

  return doi || '';
}

function abstractOf(article) {
  const parts = kids(path(article, ['Abstract']), 'AbstractText').map((n) => {
    const label = clean(attr(n, 'Label'), 100);
    const text = clean(textOf(n), 20000);

    return label && text ? `${label}: ${text}` : text;
  }).filter(Boolean);

  return clean(parts.join(' '), 50000);
}

function meshOf(citation) {
  return kids(kid(citation, 'MeshHeadingList'), 'MeshHeading').slice(0, MAX_MESH).map((h) => {
    const d = kid(h, 'DescriptorName');
    const name = clean(textOf(d), 300);

    return name ? {name, majorTopic: attr(d, 'MajorTopicYN') === 'Y' ? 'Y' : 'N'} : null;
  }).filter(Boolean);
}

/**
 * Extract the fields of one PubMed record from efetch XML.
 * @param {string} xml efetch answer
 * @param {string} pmid Expected PMID
 * @returns {Promise<Object|null>} {Title, Authors, Abstract, Reference, DOI, meshHeadings}; null when the answer has no article with this PMID
 * @throws Error when the XML cannot be parsed
 */
async function parseRecord(xml, pmid) {
  const root = await parseXml(xml);
  const set = root && root.PubmedArticleSet;
  const pa = kid(set, 'PubmedArticle');
  if (!pa) {
    return null;
  }
  const citation = kid(pa, 'MedlineCitation');
  const article = kid(citation, 'Article');
  if (!citation || !article || clean(textOf(kid(citation, 'PMID')), 20) !== pmid) {
    return null;
  }
  const authors = authorsOf(article);

  return {
    Title: clean(textOf(kid(article, 'ArticleTitle')), 2000),
    Authors: clean(authors.join(','), 20000),
    Abstract: abstractOf(article),
    Reference: referenceOf(article, authors),
    DOI: doiOf(kid(pa, 'PubmedData'), article),
    meshHeadings: meshOf(citation)
  };
}

/**
 * Fetch a record from PubMed.
 * @param {string} pmid Validated PMID (digits)
 * @returns {Promise<Object>} See parseRecord
 * @throws Parse.Error 1002 when PubMed has no record or cannot be reached
 */
async function fetchRecord(pmid) {
  await throttle();
  let res;
  try {
    res = await get(efetchUrl(pmid));
  } catch (e) {
    return fail(CODES.UPSTREAM, 'PubMed is not reachable');
  }
  if (res.status !== 200) {
    return fail(CODES.UPSTREAM, `PubMed answered ${res.status}`);
  }
  let rec;
  try {
    rec = await parseRecord(res.body, pmid);
  } catch (e) {
    return fail(CODES.UPSTREAM, 'PubMed answered something that is not valid XML');
  }
  if (!rec || !rec.Title) {
    return fail(CODES.UPSTREAM, 'PubMed has no record for this PMID');
  }

  return rec;
}

/**
 * Change the minimum gap between requests (for tests).
 * @param {number} ms Milliseconds
 * @returns {void}
 */
function setMinGap(ms) {
  minGapMs = ms;
  nextSlot = 0;
}

module.exports = {fetchRecord, parseRecord, setMinGap};
