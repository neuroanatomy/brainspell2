// Cloud Code entry point
var request = require('request-promise');
var solrURL = "http://localhost:8983/solr/brainspell/select";
Parse.Cloud.define("select", async (req) => {
  const qs = (({ q, fl, start, rows}) => ({ q, fl, start, rows }))(req.params);
  const res = await request({
    url: solrURL,
    qs: qs
  });

  return JSON.parse(res).response;
});
