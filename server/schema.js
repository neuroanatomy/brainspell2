// Class definitions of the annotation work (plan, sections 3.2 and 4.1) and their
// class-level permissions (CLP). Applied by scripts/apply-schema.js.
//
// In Parse an omitted CLP operation is open to everybody, so EVERY operation is listed.
// {} means nobody (only the master key); {"*": true} means everybody.

const PUBLIC = {'*': true};
const NOBODY = {};

const OPERATIONS = ['find', 'count', 'get', 'create', 'update', 'delete', 'addField'];

function clp(read, write) {
  return {
    find: read, count: read, get: read,
    create: write, update: write, delete: write, addField: write
  };
}

const CLOSED = clp(NOBODY, NOBODY);
const PUBLIC_READ = clp(PUBLIC, NOBODY);

const S = {type: 'String'};
const N = {type: 'Number'};
const B = {type: 'Boolean'};
const A = {type: 'Array'};

const CLASSES = [
  {
    className: 'Articles',
    // existing class: fields PMID, Title, ... are already there; only the new ones are added
    fields: {PMID: S, rev: N, indexed: B},
    indexes: {PMID_1: {PMID: 1}},
    classLevelPermissions: PUBLIC_READ
  },
  {
    className: 'Vote',
    fields: {user: S, login: S, pmid: S, experimentId: N, kind: S, ontology: S, tag: S, value: N, number: N},
    indexes: {pmid_1: {pmid: 1}, user_1_pmid_1: {user: 1, pmid: 1}},
    classLevelPermissions: CLOSED
  },
  {
    className: 'Comment',
    fields: {user: S, login: S, pmid: S, text: S},
    // NOTE: Parse Server 4.10.2 creates an index on a field literally named "createdAt"
    // (Mongo stores it as _created_at), so only the pmid prefix of this index is useful.
    indexes: {pmid_1_createdAt_1: {pmid: 1, createdAt: 1}},
    classLevelPermissions: PUBLIC_READ
  },
  {
    className: 'Collection',
    fields: {user: S, name: S, pmids: A},
    indexes: {user_1: {user: 1}},
    classLevelPermissions: CLOSED
  },
  {
    className: 'Revision',
    fields: {pmid: S, rev: N, user: S, login: S, ops: A, before: A},
    indexes: {pmid_1_rev_1: {pmid: 1, rev: 1}},
    classLevelPermissions: CLOSED
  },
  {
    className: 'Concept',
    fields: {name: S, ontology: S, definition: S, url: S, parent: S},
    indexes: {ontology_1_name_1: {ontology: 1, name: 1}},
    classLevelPermissions: PUBLIC_READ
  },
  {
    className: 'UserProfile',
    fields: {user: S, login: S, githubId: N},
    indexes: {user_1: {user: 1}},
    classLevelPermissions: CLOSED
  },
  {
    // GitHub login is a POST /users with authData, so create stays public; the beforeSave
    // trigger (cloud/auth.js) refuses users without GitHub authData.
    className: '_User',
    fields: {},
    indexes: {},
    classLevelPermissions: Object.assign(clp(NOBODY, NOBODY), {create: PUBLIC})
  },
  {
    // Integration tests showed that in Parse 4.10.2 user A could PUT on user B's _Session with
    // the default (open) CLP. Sessions are managed by Parse itself with the master key
    // (login, /users/me, /sessions/me, logout), so clients get no direct access.
    className: '_Session', fields: {}, indexes: {}, classLevelPermissions: CLOSED
  },
  {className: '_Role', fields: {}, indexes: {}, classLevelPermissions: CLOSED},
  {className: 'GameScore', fields: {}, indexes: {}, classLevelPermissions: CLOSED}
];

module.exports = {CLASSES, OPERATIONS, PUBLIC, NOBODY};
