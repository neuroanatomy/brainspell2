// PubMed efetch XML samples for the tests (synthetic, shaped like real answers).

function record(o) {
  const x = Object.assign({
    pmid: '16373395', title: 'Mesial temporal lobe <i>activity</i> &amp; memory',
    year: '2006', journal: 'Cereb. Cortex', volume: '16', issue: '2', pages: '192-9',
    doi: '10.1093/cercor/bhi098', abstract: ['Plain abstract.'], mesh: [['Brain', 'Y'], ['Humans', 'N']],
    authors: [['Abe', 'N'], ['Suzuki', 'M'], ['Tsukiura', 'T'], ['Mori', 'E'], ['Yamaguchi', 'K'], ['Fujii', 'T']]
  }, o);
  const abs = x.abstract.map((a) => (Array.isArray(a) ? `<AbstractText Label="${a[0]}">${a[1]}</AbstractText>` : `<AbstractText>${a}</AbstractText>`)).join('');
  const authors = x.authors.map((a) => `<Author><LastName>${a[0]}</LastName><ForeName>X</ForeName><Initials>${a[1]}</Initials></Author>`).join('');
  const mesh = x.mesh.map((m) => `<MeshHeading><DescriptorName UI="D1" MajorTopicYN="${m[1]}">${m[0]}</DescriptorName></MeshHeading>`).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<PubmedArticleSet><PubmedArticle><MedlineCitation Status="MEDLINE"><PMID Version="1">${x.pmid}</PMID>
<Article PubModel="Print"><Journal><JournalIssue CitedMedium="Print"><Volume>${x.volume}</Volume><Issue>${x.issue}</Issue>
<PubDate><Year>${x.year}</Year></PubDate></JournalIssue><Title>Cerebral cortex</Title><ISOAbbreviation>${x.journal}</ISOAbbreviation></Journal>
<ArticleTitle>${x.title}</ArticleTitle><Pagination><MedlinePgn>${x.pages}</MedlinePgn></Pagination>
${x.noDoiElocation ? '' : `<ELocationID EIdType="doi" ValidYN="Y">${x.doi}</ELocationID>`}
<Abstract>${abs}</Abstract><AuthorList CompleteYN="Y">${authors}</AuthorList></Article>
<MeshHeadingList>${mesh}</MeshHeadingList></MedlineCitation>
<PubmedData><ArticleIdList><ArticleId IdType="pubmed">${x.pmid}</ArticleId></ArticleIdList></PubmedData></PubmedArticle></PubmedArticleSet>`;
}

const EMPTY = '<?xml version="1.0" encoding="UTF-8"?><PubmedArticleSet></PubmedArticleSet>';

module.exports = {record, EMPTY};
