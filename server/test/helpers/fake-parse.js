// In-memory fake of the parts of the Parse API used by the cloud code (for node --test).
// It is deliberately strict: a query or a save without the master key (or a session token)
// is refused with 119, like a class whose class-level permissions are all closed, and a
// query without an explicit limit returns 100 objects, like the real one.

class ParseError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'ParseError';
  }
}

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function create() {
  const store = new Map(); // className -> Map(id -> {id, createdAt, updatedAt, data, acl})
  const functions = new Map();
  const beforeSave = new Map();
  let counter = 0;
  let clockMs = Date.UTC(2026, 0, 1);

  const tick = () => new Date(clockMs += 1000);
  const table = (c) => {
    if (!store.has(c)) {
      store.set(c, new Map());
    }

    return store.get(c);
  };
  const needMaster = (opts) => {
    if (!opts || (opts.useMasterKey !== true && !opts.sessionToken)) {
      throw new ParseError(119, 'Permission denied (fake: master key missing)');
    }
  };

  class ACL {
    constructor() {
      this.read = false;
      this.write = false;
    }
    setPublicReadAccess(b) {
      this.read = Boolean(b);
    }
    setPublicWriteAccess(b) {
      this.write = Boolean(b);
    }
    getPublicReadAccess() {
      return this.read;
    }
    getPublicWriteAccess() {
      return this.write;
    }
    toJSON() {
      const o = {};
      if (this.read || this.write) {
        o['*'] = {};
        if (this.read) {
          o['*'].read = true;
        }
        if (this.write) {
          o['*'].write = true;
        }
      }

      return o;
    }
  }

  class ParseObject {
    constructor(className) {
      this.className = className;
      this.id = undefined;
      this.createdAt = undefined;
      this.updatedAt = undefined;
      this._data = {};
      this._acl = null;
    }
    get(k) {
      return this._data[k];
    }
    set(k, v) {
      this._data[k] = v === undefined ? undefined : clone(v);

      return this;
    }
    setACL(acl) {
      this._acl = acl;
    }
    getACL() {
      return this._acl;
    }
    toJSON() {
      return Object.assign({objectId: this.id}, clone(this._data));
    }
    existed() {
      return this.id !== undefined;
    }
    async save(_attrs, opts) {
      needMaster(opts);
      const isNew = this.id === undefined;
      const rows = table(this.className);
      if (isNew) {
        const trig = beforeSave.get(this.className);
        if (trig) {
          await trig({object: this, original: undefined, master: Boolean(opts.useMasterKey), user: undefined});
        }
        this.id = `${this.className.replace(/^_/, '')}${++counter}`;
        this.createdAt = tick();
        this.updatedAt = this.createdAt;
      } else {
        const trig = beforeSave.get(this.className);
        if (trig) {
          await trig({object: this, original: this, master: Boolean(opts.useMasterKey), user: undefined});
        }
        this.updatedAt = tick();
      }
      rows.set(this.id, {
        id: this.id, createdAt: this.createdAt, updatedAt: this.updatedAt,
        data: clone(this._data), acl: this._acl ? this._acl.toJSON() : null
      });

      return this;
    }
    async destroy(opts) {
      needMaster(opts);
      if (!table(this.className).delete(this.id)) {
        throw new ParseError(101, 'Object not found.');
      }

      return this;
    }
  }

  function inflate(className, rec) {
    const o = className === '_User' ? new ParseUser() : new ParseObject(className);
    o.id = rec.id;
    o.createdAt = rec.createdAt;
    o.updatedAt = rec.updatedAt;
    o._data = clone(rec.data);

    return o;
  }

  class ParseUser extends ParseObject {
    constructor() {
      super('_User');
    }
  }
  ParseUser.className = '_User';

  const matches = (rec, conds) => conds.every((c) => {
    const v = c.field === 'objectId' ? rec.id : c.field.split('.').reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), rec.data);
    switch (c.op) {
    case 'ne':
      return v !== c.value;
    case 'eq':
      return c.value === null ? v === undefined || v === null : v === c.value;
    case 'in':
      return c.value.includes(v);
    default:
      return false;
    }
  });

  class ParseQuery {
    constructor(cls) {
      this.className = typeof cls === 'string' ? cls : cls.className;
      this.conds = [];
      this.order = [];
      this.lim = 100;
      this.skp = 0;
    }
    equalTo(f, v) {
      this.conds.push({op: 'eq', field: f, value: v});

      return this;
    }
    notEqualTo(f, v) {
      this.conds.push({op: 'ne', field: f, value: v});

      return this;
    }
    containedIn(f, v) {
      this.conds.push({op: 'in', field: f, value: v});

      return this;
    }
    limit(n) {
      this.lim = n;

      return this;
    }
    skip(n) {
      this.skp = n;

      return this;
    }
    descending(f) {
      this.order = [{f, dir: -1}];

      return this;
    }
    ascending(f) {
      this.order = [{f, dir: 1}];

      return this;
    }
    addDescending(f) {
      this.order.push({f, dir: -1});

      return this;
    }
    addAscending(f) {
      this.order.push({f, dir: 1});

      return this;
    }
    _all() {
      let list = Array.from(table(this.className).values()).filter((r) => matches(r, this.conds));
      const val = (r, f) => {
        if (f === 'createdAt' || f === 'updatedAt') {
          return r[f].getTime();
        }
        if (f === 'objectId') {
          return r.id;
        }

        return r.data[f];
      };
      const order = this.order.length ? this.order : [{f: 'createdAt', dir: 1}];
      list = list.sort((a, b) => {
        for (const {f, dir} of order) {
          const x = val(a, f);
          const y = val(b, f);
          if (x < y) {
            return -dir;
          }
          if (x > y) {
            return dir;
          }
        }

        return 0;
      });

      return list;
    }
    async find(opts) {
      needMaster(opts);

      return this._all().slice(this.skp, this.skp + this.lim).map((r) => inflate(this.className, r));
    }
    async first(opts) {
      needMaster(opts);
      const l = this._all();

      return l.length ? inflate(this.className, l[0]) : undefined;
    }
    async get(id, opts) {
      needMaster(opts);
      const r = table(this.className).get(id);
      if (!r) {
        throw new ParseError(101, 'Object not found.');
      }

      return inflate(this.className, r);
    }
    async count(opts) {
      needMaster(opts);

      return this._all().length;
    }
  }

  const Cloud = {
    define(name, fn) {
      functions.set(name, fn);
    },
    beforeSave(cls, fn) {
      beforeSave.set(typeof cls === 'string' ? cls : cls.className, fn);
    },
    // Calls a cloud function like the client would: params and result go through JSON.
    async run(name, params, ctx) {
      const fn = functions.get(name);
      if (!fn) {
        throw new ParseError(141, `Invalid function: "${name}"`);
      }
      const request = {
        params: clone(params === undefined ? {} : params),
        user: ctx && ctx.user,
        master: false,
        ip: '127.0.0.1'
      };
      try {
        return clone(await fn(request));
      } catch (e) {
        throw e instanceof ParseError ? e : new ParseError(141, e && e.message);
      }
    }
  };

  const Parse = {
    Error: ParseError, Object: ParseObject, User: ParseUser, Query: ParseQuery, ACL, Cloud
  };

  // test helpers
  const fake = {
    Parse,
    functions,
    // Create a stored _User; returns a Parse.User like request.user.
    addUser(authData, extra) {
      const u = new ParseUser();
      u.id = `user${++counter}`;
      u.createdAt = u.updatedAt = tick();
      u._data = Object.assign({}, extra);
      if (authData !== undefined) {
        u._data.authData = clone(authData);
      }
      table('_User').set(u.id, {
        id: u.id, createdAt: u.createdAt, updatedAt: u.updatedAt, data: clone(u._data), acl: null
      });

      return u;
    },
    addGithubUser(id, token) {
      return fake.addUser({github: {id: String(id), access_token: token || `token-${id}`}});
    },
    addArticle(fields) {
      const o = new ParseObject('Articles');
      o.id = `Articles${++counter}`;
      o.createdAt = o.updatedAt = tick();
      o._data = clone(fields);
      table('Articles').set(o.id, {
        id: o.id, createdAt: o.createdAt, updatedAt: o.updatedAt, data: clone(o._data), acl: null
      });

      return o;
    },
    add(className, fields) {
      const o = new ParseObject(className);
      o.id = `${className}${++counter}`;
      o.createdAt = o.updatedAt = tick();
      o._data = clone(fields);
      table(className).set(o.id, {
        id: o.id, createdAt: o.createdAt, updatedAt: o.updatedAt, data: clone(o._data), acl: null
      });

      return o;
    },
    rows(className) {
      return Array.from(table(className).values()).map((r) => Object.assign({id: r.id, acl: r.acl}, clone(r.data)));
    },
    run: (name, params, user) => Cloud.run(name, params, {user})
  };

  return fake;
}

module.exports = {create, ParseError};
