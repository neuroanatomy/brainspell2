/* globals Parse */
import TranslucentLocations from "./node_modules/translucent-viewer/translucent-locations.js";

const setupTouch = () => {
  console.log("configure touch");

  // Is JS enabled? Is it a touch device?
  const htmlTag = document.getElementsByTagName('html').item(0);
  htmlTag.className = (htmlTag.className + ' ' || '') + 'hasJS';
  if ('ontouchstart' in document.documentElement) {
    htmlTag.className = (htmlTag.className + ' ' || '') + 'isTouch';
  }
};

const displayMeshHeadings = (mesh) => {
  const m = `
    <div class="mesh">
        <h2>Medical Subject Headings</h2>
        ${mesh.map((o) => '<span class="tag">' + o.name + '</span> ').join(' ')}
    </div>
    `;
  document.getElementById('article').innerHTML += m;
};

const displayExperiments = (exp) => {
  let ex, i;
  document.getElementById('article').innerHTML += `
<div class="experiments">
<h2>Experiments</h2>
    `;
  for(i=0; i<exp.length; i++) {
    ex = exp[i];
    if(ex.locations.length === 0) {
      continue;
    }
    const t = `
<div class="experiment">
<b>${i}.</b> <b class='noEmptyWithPlaceholder' placeholder='No Title'>${ex.title}</b><br />
<span class='noEmptyWithPlaceholder' placeholder='No Caption'>${ex.caption}</span><br />
<table>
<tr>
  <td style="vertical-align:top">
    <div id="viewer${i}" style="width:480px;height:480px; border:1px solid #111"></div>
  </td>
  <td style="vertical-align:top; border:1px solid #2d2d2d">
    <table class="coords-table">
      <thead>
        <tr>
          <th><span class="text">X</span></th>
          <th><span class="text">Y</span></th>
          <th><span class="text">Z</span></th>
        </tr>
      </thead>
    </table>
    <div id="table-wrapper">
      <div id="table-scroll">
        <table class="coords-table">
          <tbody>
            ${ex.locations.map((o) => '<tr><td>'+o.replace(/,/g, '</td><td>')+'</td></tr>').join('')}
          </tbody>
        </table>
      </div>
    </div>
  </td>
</tr>
</table>
</div>`;
    document.getElementById('article').innerHTML += t;
    const l = ex.locations.map((o) => o.split(',').map( (o2) => parseFloat(o2)));
    var trl = new TranslucentLocations({
      elemId:`viewer${i}`,
      assetsPath: "/node_modules/translucent-viewer/",
      backgroundColor: 0x202020,
      alpha: 1,
      brainColor: 0xffffff,
      locations: l
    });
    trl.init();
  }
  document.getElementById('article').innerHTML += `
        </div>
    `;
};

const displayArticle = (ob) => {
  const art = ob.toJSON();
  document.getElementById('article').innerHTML = `
    <h2>${art.Title}</h2>
    <b>${art.Authors.replace(/,/g, ', ').replace(/ {2}/g, ' ')} ${art.Reference}</b>
    <p>${art.Abstract}</p>
    `;
  displayMeshHeadings(art.Metadata.meshHeadings);
  displayExperiments(art.Experiments);
};

export const init = () => {
  setupTouch();

  const params = new URLSearchParams(location.search);

  if(params.has('pmid')) {
    const pmid = params.get('pmid');
    const Article = Parse.Object.extend("Articles");
    const query = new Parse.Query(Article);
    query.equalTo("PMID", pmid);
    query.first().then(displayArticle);
  }
};
