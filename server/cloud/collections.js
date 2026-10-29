// listCollections, saveCollection, deleteCollection (plan, section 4.3). Owner only.

var {fail, CODES} = require('../lib/errors');
var validate = require('../lib/validate');
var {requireGithubUser} = require('../lib/auth');
var {withLock} = require('../lib/locks');
var rateLimit = require('../lib/rate-limit');
var {cleanName} = require('../lib/normalize');
var {MASTER} = require('../lib/articles');

var MAX_COLLECTIONS = 50;
var MAX_PMIDS = 2000;

function view(o) {
  var pmids = o.get('pmids');

  return {
    id: o.id,
    name: o.get('name'),
    pmids: Array.isArray(pmids) ? pmids : [],
    updatedAt: (o.updatedAt || o.createdAt).toISOString()
  };
}

function collectionId(v) {
  validate.str(v, 'id', {min: 1, max: 64});
  if (!/^[A-Za-z0-9_-]+$/.test(v)) {
    fail(CODES.VALIDATION, 'id: invalid');
  }

  return v;
}

function pmidList(v, name) {
  if (!Array.isArray(v)) {
    fail(CODES.VALIDATION, `${name}: must be an array of PMIDs`);
  }
  if (v.length > MAX_PMIDS) {
    fail(CODES.VALIDATION, `${name}: at most ${MAX_PMIDS} PMIDs per call`);
  }
  v.forEach((x, i) => {
    if (typeof x !== 'string' || !/^[0-9]{1,9}$/.test(x)) {
      fail(CODES.VALIDATION, `${name}[${i}]: must be a string of 1 to 9 digits`);
    }
  });

  return v;
}

async function ownCollection(user, id) {
  var q = new Parse.Query('Collection');
  var o;
  try {
    o = await q.get(id, MASTER);
  } catch (e) {
    if (e && e.code === CODES.NOT_FOUND) {
      return fail(CODES.NOT_FOUND, 'Collection not found');
    }
    throw e;
  }
  if (!o) {
    return fail(CODES.NOT_FOUND, 'Collection not found');
  }
  if (o.get('user') !== user.id) {
    return fail(CODES.FORBIDDEN, 'Not your collection');
  }

  return o;
}

Parse.Cloud.define('listCollections', async (request) => {
  var {user, githubId} = await requireGithubUser(request);
  validate.noUnknown(request.params, []);
  var q = new Parse.Query('Collection');
  q.equalTo('user', user.id);
  q.ascending('createdAt');
  q.addAscending('objectId');
  q.limit(MAX_COLLECTIONS + 50);
  var list = await q.find(MASTER);

  return list.map(view);
});

Parse.Cloud.define('saveCollection', async (request) => {
  var {user, githubId} = await requireGithubUser(request);
  var p = validate.noUnknown(request.params, ['id', 'name', 'add', 'remove']);
  var id = validate.has(p, 'id') ? collectionId(p.id) : null;
  var name = null;
  if (validate.has(p, 'name') || !id) {
    name = cleanName(validate.str(p.name, 'name', {min: 1, max: 100}));
    if (!name) {
      fail(CODES.VALIDATION, 'name: must not be empty');
    }
  }
  var add = validate.has(p, 'add') ? pmidList(p.add, 'add') : [];
  var remove = validate.has(p, 'remove') ? pmidList(p.remove, 'remove') : [];
  rateLimit.check(String(githubId), 'saveCollection');

  return withLock(`collections:${githubId}`, async () => {
    var o;
    if (id) {
      o = await ownCollection(user, id);
    } else {
      var c = new Parse.Query('Collection');
      c.equalTo('user', user.id);
      if (await c.count(MASTER) >= MAX_COLLECTIONS) {
        fail(CODES.VALIDATION, `collections: at most ${MAX_COLLECTIONS} collections per user`);
      }
      o = new Parse.Object('Collection');
      o.setACL(new Parse.ACL());
      o.set('user', user.id);
      o.set('pmids', []);
    }
    var gone = new Set(remove);
    var seen = new Set();
    var pmids = [];
    (Array.isArray(o.get('pmids')) ? o.get('pmids') : []).filter((x) => !gone.has(x)).concat(add).forEach((x) => {
      if (!seen.has(x)) {
        seen.add(x);
        pmids.push(x);
      }
    });
    if (pmids.length > MAX_PMIDS) {
      fail(CODES.VALIDATION, `pmids: a collection holds at most ${MAX_PMIDS} articles`);
    }
    if (name !== null) {
      o.set('name', name);
    }
    o.set('pmids', pmids);
    await o.save(null, MASTER);

    return view(o);
  });
});

Parse.Cloud.define('deleteCollection', async (request) => {
  var {user, githubId} = await requireGithubUser(request);
  var p = validate.noUnknown(request.params, ['id']);
  var id = collectionId(p.id);

  return withLock(`collections:${githubId}`, async () => {
    var o = await ownCollection(user, id);
    await o.destroy(MASTER);

    return {id: id};
  });
});
