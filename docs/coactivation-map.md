# The coactivation map of the search page

`search.html?q=...` shows a translucent brain with the regions where the peaks of the matching papers overlap, and the list of papers. Code:
`client/annotation/coactivation.js` (no DOM, unit tested in `client/test/coactivation.test.js`) and `client/search.js` (connects it to Parse, the viewer and the page).

## How it works

Two pipelines share ONE request pool (3 requests in flight at most; retry with backoff on rate limit 155 and on network errors, 3 tries; cancelled when the page is left):

1. **Solr pages**: `select` with `rows=50`, `fl="score,id"` (ids and scores only), at most about 15 calls per second (the server allows 30 per second for all visitors together).
2. **Map**: for every Solr page, ONE read of `PMID,Experiments` of its 50 papers; the peaks go into the accumulator as pages arrive (the order does not matter).
3. **List**: only the papers that are shown. The first 20 (`PMID,Title,Reference,DOI`) as soon as the first Solr page is back, the next 20 when the end of the list scrolls into view. The Solr score is matched to a record by objectId (not by position).

Article reads are plain REST requests (a POST with a text/plain body like the Parse SDK's: no CORS preflight), not `Parse.Query`: the SDK keeps one shared object per id, and a second partial query for the same ids can come back without the new fields.

The accumulator is the original algorithm: a 45 x 54 x 45 volume, a peak "x,y,z" (mm) goes to voxel `floor(c/4 + [22, 31, 17.5])`, one count in every voxel of a ball of radius 3 around it. A test compares it voxel by voxel with the original code on 1060 real peaks and on random ones.

**Rendering**: the accumulator is the `target`; a `display` volume eases toward it (exponential, time constant 250 ms), is smoothed with a small 3D Gaussian (sigma 1 voxel) and sent to the library's `updateMesh` at most about 15 times per second while it is changing; when it has converged the timer stops (no idle work). The slider level eases too. The level is a percentage of the strongest region in peak counts, so "50% = at least 124 overlapping peaks" is a statement about counts.

## What you see

* `Map from 150 of 445 papers` (top left of the map) while loading, `Map from 445 papers` when complete; with a failed request: `... some data could not be loaded`, and a red notice under the slider.
* Next to the slider: `50% = at least 124 overlapping peaks` (updates with the data and the slider).
* The list appears with the first Solr page (about 0.4 s on the live server), not after the whole search.

## Numbers (live server, headless Chrome with software WebGL, the page served locally)

| query | before | after |
|---|---|---|
| "prosodic" (37 papers): complete map | 3.3 s, 9 requests | 0.5 s, 4 requests |
| "cognition" (445): first results / map complete | 2.3 s / 17.4 s, 91 requests | 0.4 s / 2.3 s, 20 requests |
| working memory (1753): first results / map complete | 2.1 s / 63.7 s, 353 requests | 0.4 s / 4.1 s, 74 requests |
| "cognition" with 200 ms added latency | | 2.7 s / 4.0 s |

(The old page showed the first results only when they were below the fold; "before" measures the map.)

## Knobs

* `?smooth=0`: no easing and no smoothing: the plain map, identical to the old page's (use it to compare).
* `createPool({limit: 3})` and `createPacer(65)` in `search.js` (requests in flight, milliseconds between `select` calls); `tau`, `sigma`, `minInterval` in `createMapRenderer`.
* If the server refuses a `start` offset (very large result sets) the later Solr pages are not requested and the map is partial, with the notice.

Verify before a deployment with `node client/test/tools/smoke.mjs <base-url>` (it fails if the map of "prosodic" or "cognition" is not complete in 10 s).
