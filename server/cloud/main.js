// Cloud Code entry point: loads every other *.js file of this folder.
// Each file registers its own cloud functions and triggers.

var fs = require('fs');
var path = require('path');

var self = path.basename(__filename);

fs.readdirSync(__dirname)
  .filter((f) => f.endsWith('.js') && f !== self)
  .sort()
  .forEach((f) => {
    require(path.join(__dirname, f));
  });
