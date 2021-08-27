// Cloud Code entry point

var request = require('request-promise');
var solrURL = "http://localhost:8983/solr/brainspell/select";
Parse.Cloud.define("select", async (req) => {
    const qs = (({ q, fl, defType, qf, start, rows}) => ({ q, fl, defType, qf, start, rows }))(req.params);
    let res = await request({
        url: solrURL,
        qs: qs
    });
    return JSON.parse(res).response;
});