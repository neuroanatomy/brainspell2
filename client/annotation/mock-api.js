/**
 * In-memory implementation of the cloud-function interface of plan section 4.3, for developing
 * the client without a server (api.js uses it with ?mock=1) and for tests. It reproduces the
 * documented behaviour and the error codes of 4.2, including the display rule of 3.4.
 * It is not a security model: it just refuses what the real server refuses.
 */

const E = {VALIDATION: 142, NOT_LOGGED_IN: 206, FORBIDDEN: 119, RATE: 155, NOT_FOUND: 101, EXISTS: 137, CONFLICT: 1001};

const fail = (code, message) => {
  const e = new Error(message);
  e.code = code;
  throw e;
};

export const tagKey = (s) => String(s).normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();

const ONTOLOGIES = ["cognitive", "behavioural", "tasks"];

const CONCEPTS = {
  cognitive: [
    {name: "attention", parent: ""}, {name: "working memory", parent: "memory"},
    {name: "memory", parent: ""}, {name: "face perception", parent: "perception"},
    {name: "perception", parent: ""}, {name: "emotion", parent: ""}
  ],
  behavioural: [
    {name: "Cognition", parent: ""}, {name: "Cognition.Attention", parent: "Cognition"},
    {name: "Action.Execution", parent: "Action"}, {name: "Perception.Vision", parent: "Perception"}
  ],
  tasks: [
    {name: "n-back task", parent: ""}, {name: "Stroop task", parent: ""}, {name: "go/no-go task", parent: ""}
  ]
};

export const sampleArticles = () => ({
  "12345": {
    objectId: "obj12345",
    PMID: "12345",
    Title: "Sample &lt;i&gt;mock&lt;/i&gt; article about working memory &amp; attention",
    Authors: "Smith J,Doe A,Roe B",
    Reference: "Mock J Neurosci 2020; 1:1-10",
    Abstract: "This abstract has an entity &lt;b&gt;not bold&lt;/b&gt; and <script>window.__xss = 1</script> markup that must stay inert.",
    Metadata: {
      meshHeadings: [
        {name: "Brain", majorTopic: true}, {name: "Memory, Short-Term", majorTopic: false},
        {name: "Attention", majorTopic: false}, {name: "<img src=x onerror=alert(1)>", majorTopic: false}
      ],
      stereo: {MNI: 2, Talairach: 1},
      nsubjects: 20
    },
    Experiments: [
      {
        id: 1, title: "Task > baseline", caption: "Activations for <b>task</b> vs baseline",
        locations: ["-42,18,24", "44,20,26", "-8,-72,12", "30,-60,-14", "0,12,48"],
        tags: [{name: "working memory", ontology: "cognitive", agree: 3, disagree: 1}, {name: "Stroop task", ontology: "tasks", agree: 0, disagree: 0}],
        markBadTable: {ok: 2, bad: 1}
      },
      {
        id: 2, title: "", caption: "", locations: ["10,10,10", "-10,-10,-10"],
        tags: [], markBadTable: {ok: 0, bad: 0}
      },
      {id: 3, title: "Empty table", caption: "No coordinates yet", locations: [], tags: [], markBadTable: {ok: 0, bad: 0}}
    ],
    rev: 0
  },
  "67890": {
    objectId: "obj67890",
    PMID: "67890",
    Title: "A second article without any legacy annotation",
    Authors: "Poe E",
    Reference: "Mock Brain 2019; 2:20-30",
    Abstract: "Plain abstract.",
    Metadata: {meshHeadings: [{name: "Humans", majorTopic: false}]},
    Experiments: [{id: 1, title: "T", caption: "C", locations: ["1,2,3"], tags: [], markBadTable: {ok: 0, bad: 0}}],
    rev: 0
  }
});

const clone = (o) => JSON.parse(JSON.stringify(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WRITES = new Set(["vote", "setStereoSpace", "setNSubjects", "postComment", "editExperiment", "addArticle", "saveCollection", "deleteCollection"]);
const LIMITS = {vote: [60, 60e3], postComment: [5, 60e3], editExperiment: [30, 60e3], addArticle: [5, 3600e3], saveCollection: [30, 60e3]};

const noUnknown = (p, allowed) => {
  for (const k of Object.keys(p)) {
    if (!allowed.includes(k)) {
      fail(E.VALIDATION, `unknown parameter: ${k}`);
    }
  }
};
const str = (v, name, min, max) => {
  if (typeof v !== "string" || v.length < min || v.length > max) {
    fail(E.VALIDATION, `${name} must be a string of ${min} to ${max} characters`);
  }

  return v;
};
const int = (v, name, min, max) => {
  if (!Number.isInteger(v) || v < min || v > max) {
    fail(E.VALIDATION, `${name} must be an integer between ${min} and ${max}`);
  }

  return v;
};
const pmidOf = (v) => {
  if (typeof v !== "string" || !/^\d{1,9}$/.test(v)) {
    fail(E.VALIDATION, "pmid must be a string of digits (up to 9)");
  }

  return v;
};

/**
 * @param {object} opts
 * @param {string|null} opts.user login of the signed-in user (null: anonymous)
 * @param {number|null} opts.failCode every write function fails with this code
 * @param {number} opts.latency artificial latency in ms
 * @param {function} opts.now clock in ms (tests)
 * @param {object} opts.articles initial articles, keyed by PMID
 */
export const createMockApi = (opts = {}) => {
  const state = {
    user: opts.user || null,
    articles: clone(opts.articles || sampleArticles()),
    votes: [], // {user, login, pmid, experimentId, kind, ontology, tag, value, number, t}
    comments: [],
    collections: [],
    calls: {}, // rate limits: key -> [timestamps]
    seq: 0
  };
  const now = opts.now || (() => Date.now());
  const latency = typeof opts.latency === "number" ? opts.latency : 0;
  const failCode = opts.failCode || null;

  const userId = () => `u_${state.user}`;
  const requireUser = () => {
    if (!state.user) {
      fail(E.NOT_LOGGED_IN, "Login required");
    }
  };
  const rateLimit = (name) => {
    const [max, win] = LIMITS[name];
    const key = `${userId()}:${name}`;
    const t = now();
    const list = (state.calls[key] || []).filter((x) => t - x < win);
    if (list.length >= max) {
      fail(E.RATE, `Rate limit exceeded, retry in ${Math.ceil((win - (t - list[0])) / 1000)} s`);
    }
    list.push(t);
    state.calls[key] = list;
    if (name === "postComment") {
      const dayKey = `${key}:day`;
      const day = (state.calls[dayKey] || []).filter((x) => t - x < 86400e3);
      if (day.length >= 20) {
        fail(E.RATE, "Rate limit exceeded, retry in 86400 s");
      }
      day.push(t);
      state.calls[dayKey] = day;
    }
  };
  const article = (pmid) => state.articles[pmidOf(pmid)] || fail(E.NOT_FOUND, "Article not found");
  const rowsOf = (pmid, pred) => state.votes.filter((v) => v.pmid === pmid && pred(v));

  // --- counting --------------------------------------------------------------------------------

  const countFor = (art, v) => {
    // v: {kind, experimentId, ontology, tag}
    let agree = 0;
    let disagree = 0;
    const exp = art.Experiments.find((x) => x.id === v.experimentId);
    if (v.kind === "tag" && exp) {
      const legacy = (exp.tags || []).find((t) => t.ontology === v.ontology && tagKey(t.name) === tagKey(v.tag));
      if (legacy) {
        agree += legacy.agree || 0;
        disagree += legacy.disagree || 0;
      }
    }
    if (v.kind === "tableOk" && exp && exp.markBadTable) {
      agree += exp.markBadTable.ok || 0;
      disagree += exp.markBadTable.bad || 0;
    }
    let mine = 0;
    for (const r of rowsOf(art.PMID, (x) => x.kind === v.kind && x.experimentId === v.experimentId &&
      (x.ontology || null) === (v.ontology || null) && tagKey(x.tag) === tagKey(v.tag))) {
      if (r.value === 1) { agree++; } else { disagree++; }
      if (r.user === (state.user && userId())) { mine = r.value; }
    }

    return {agree, disagree, mine};
  };

  const stereoOf = (art) => {
    const legacy = (art.Metadata && art.Metadata.stereo) || {};
    const out = {MNI: legacy.MNI || 0, Talairach: legacy.Talairach || 0, mine: null};
    if (!art.Metadata.stereo && typeof art.Metadata.space === "string" && out[art.Metadata.space] !== undefined) {
      out[art.Metadata.space] += 1;
    }
    for (const r of rowsOf(art.PMID, (x) => x.kind === "space")) {
      out[r.tag] += 1;
      if (r.user === (state.user && userId())) { out.mine = r.tag; }
    }

    return out;
  };

  const nsubjectsOf = (art) => {
    const counts = new Map();
    const latest = new Map();
    let mine = null;
    for (const r of rowsOf(art.PMID, (x) => x.kind === "nsubjects")) {
      counts.set(r.number, (counts.get(r.number) || 0) + 1);
      latest.set(r.number, Math.max(latest.get(r.number) || 0, r.t));
      if (r.user === (state.user && userId())) { mine = r.number; }
    }
    const values = [...counts.entries()].map(([n, count]) => ({n, count})).sort((a, b) => b.count - a.count || latest.get(b.n) - latest.get(a.n));
    const legacy = art.Metadata && Number.isInteger(art.Metadata.nsubjects) ? art.Metadata.nsubjects : null;

    return {value: values.length ? values[0].n : legacy, values, mine};
  };

  const votesOf = (art) => {
    const out = [];
    for (const h of (art.Metadata.meshHeadings || [])) {
      out.push({kind: "mesh", experimentId: -1, ontology: null, tag: h.name, ...countFor(art, {kind: "mesh", experimentId: -1, ontology: null, tag: h.name})});
    }
    for (const exp of art.Experiments) {
      out.push({kind: "tableOk", experimentId: exp.id, ontology: null, tag: "ok", ...countFor(art, {kind: "tableOk", experimentId: exp.id, ontology: null, tag: "ok"})});
      const seen = new Set();
      const cands = (exp.tags || []).map((t) => ({ontology: t.ontology, tag: t.name}))
        .concat(rowsOf(art.PMID, (x) => x.kind === "tag" && x.experimentId === exp.id).map((r) => ({ontology: r.ontology, tag: r.tag})));
      for (const c of cands) {
        const k = `${c.ontology}|${tagKey(c.tag)}`;
        if (seen.has(k)) { continue; }
        seen.add(k);
        const n = countFor(art, {kind: "tag", experimentId: exp.id, ...c});
        if (n.agree + n.disagree >= 1) { // display rule 3.4
          out.push({kind: "tag", experimentId: exp.id, ontology: c.ontology, tag: c.tag, ...n});
        }
      }
    }

    return out;
  };

  const commentsOf = (pmid) => {
    const all = state.comments.filter((c) => c.pmid === pmid);

    return {list: all.slice(-200).map(({id, login, text, createdAt}) => ({id, login, text, createdAt})), count: all.length};
  };

  // --- functions -------------------------------------------------------------------------------

  const fns = {
    me: (p) => {
      noUnknown(p, []);

      return state.user ? {id: userId(), login: state.user, githubId: 1000 + state.user.length} : null;
    },

    getAnnotations: (p) => {
      noUnknown(p, ["pmid"]);
      const art = article(p.pmid);
      const c = commentsOf(art.PMID);

      return clone({
        pmid: art.PMID, rev: art.rev || 0, votes: votesOf(art), stereo: stereoOf(art), nsubjects: nsubjectsOf(art),
        comments: c.list, commentCount: c.count
      });
    },

    vote: (p) => {
      noUnknown(p, ["pmid", "experimentId", "kind", "ontology", "tag", "value"]);
      requireUser();
      const art = article(p.pmid);
      if (!["mesh", "tag", "tableOk"].includes(p.kind)) { fail(E.VALIDATION, "kind must be mesh, tag or tableOk"); }
      if (![1, -1, 0].includes(p.value)) { fail(E.VALIDATION, "value must be 1, -1 or 0"); }
      rateLimit("vote");
      let experimentId = -1;
      let ontology = null;
      let tag = p.tag;
      if (p.kind === "mesh") {
        if (p.experimentId !== -1) { fail(E.VALIDATION, "experimentId must be -1 for mesh"); }
        const h = (art.Metadata.meshHeadings || []).find((x) => tagKey(x.name) === tagKey(str(p.tag, "tag", 1, 500)));
        if (!h) { fail(E.VALIDATION, "tag is not a heading of this article"); }
        tag = h.name;
      } else {
        experimentId = int(p.experimentId, "experimentId", 0, 1e9);
        const exp = art.Experiments.find((x) => x.id === experimentId);
        if (!exp) { fail(E.VALIDATION, "experimentId does not exist in this article"); }
        if (p.kind === "tableOk") {
          tag = "ok";
        } else {
          if (!ONTOLOGIES.includes(p.ontology)) { fail(E.VALIDATION, "ontology must be cognitive, behavioural or tasks"); }
          ontology = p.ontology;
          str(p.tag, "tag", 1, 500);
          const concept = CONCEPTS[ontology].find((c) => tagKey(c.name) === tagKey(p.tag));
          const legacy = (exp.tags || []).find((t) => t.ontology === ontology && tagKey(t.name) === tagKey(p.tag));
          if (!concept && !legacy) { fail(E.VALIDATION, "tag is not a known term of this ontology"); }
          tag = concept ? concept.name : legacy.name;
        }
      }
      const key = {kind: p.kind, experimentId, ontology, tag};
      const mineIdx = state.votes.findIndex((r) => r.pmid === art.PMID && r.user === userId() && r.kind === key.kind &&
        r.experimentId === experimentId && (r.ontology || null) === ontology && tagKey(r.tag) === tagKey(tag));
      if (p.value === 0) {
        if (mineIdx >= 0) { state.votes.splice(mineIdx, 1); }
      } else if (mineIdx >= 0) {
        state.votes[mineIdx].value = p.value;
        state.votes[mineIdx].t = now();
      } else {
        state.votes.push({user: userId(), login: state.user, pmid: art.PMID, ...key, value: p.value, number: null, t: now()});
      }

      return {...key, ...countFor(art, key)};
    },

    setStereoSpace: (p) => {
      noUnknown(p, ["pmid", "space"]);
      requireUser();
      const art = article(p.pmid);
      if (p.space !== null && !["MNI", "Talairach"].includes(p.space)) { fail(E.VALIDATION, "space must be MNI, Talairach or null"); }
      rateLimit("vote");
      state.votes = state.votes.filter((r) => !(r.pmid === art.PMID && r.user === userId() && r.kind === "space"));
      if (p.space) {
        state.votes.push({user: userId(), login: state.user, pmid: art.PMID, experimentId: -1, kind: "space", ontology: null, tag: p.space, value: 1, number: null, t: now()});
      }

      return stereoOf(art);
    },

    setNSubjects: (p) => {
      noUnknown(p, ["pmid", "n"]);
      requireUser();
      const art = article(p.pmid);
      if (p.n !== null) { int(p.n, "n", 1, 100000); }
      rateLimit("vote");
      state.votes = state.votes.filter((r) => !(r.pmid === art.PMID && r.user === userId() && r.kind === "nsubjects"));
      if (p.n !== null) {
        state.votes.push({user: userId(), login: state.user, pmid: art.PMID, experimentId: -1, kind: "nsubjects", ontology: null, tag: "n", value: 1, number: p.n, t: now()});
      }

      return nsubjectsOf(art);
    },

    postComment: (p) => {
      noUnknown(p, ["pmid", "text"]);
      requireUser();
      const art = article(p.pmid);
      str(p.text, "text", 1, 5000);
      rateLimit("postComment");
      const c = {id: `c${++state.seq}`, login: state.user, text: p.text, createdAt: new Date(now()).toISOString(), pmid: art.PMID};
      state.comments.push(c);

      return {id: c.id, login: c.login, text: c.text, createdAt: c.createdAt};
    },

    editExperiment: (p) => {
      noUnknown(p, ["pmid", "experimentId", "rev", "ops"]);
      requireUser();
      const art = article(p.pmid);
      rateLimit("editExperiment");
      int(p.experimentId, "experimentId", 0, 1e9);
      int(p.rev, "rev", 0, 1e9);
      if (!Array.isArray(p.ops) || p.ops.length < 1 || p.ops.length > 200) { fail(E.VALIDATION, "ops must have 1 to 200 operations"); }
      if ((art.rev || 0) !== p.rev) { fail(E.CONFLICT, `Conflict, current rev is ${art.rev || 0}`); }
      const exps = clone(art.Experiments);
      let idx = exps.findIndex((x) => x.id === p.experimentId);
      if (idx < 0) { fail(E.VALIDATION, "experimentId does not exist in this article"); }
      const changed = new Set([p.experimentId]);
      const fmt = (n) => String(Math.round(n * 1000) / 1000);
      const xyzOf = (a) => {
        if (!Array.isArray(a) || a.length !== 3 || !a.every((n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 200)) {
          fail(E.VALIDATION, "xyz must be three finite numbers in [-200, 200]");
        }

        return a.map(fmt).join(",");
      };
      for (const op of p.ops) {
        const ex = exps[idx];
        switch (op && op.op) {
        case "setTitle": ex.title = str(op.text, "text", 0, 1000); break;
        case "setCaption": ex.caption = str(op.text, "text", 0, 5000); break;
        case "updateRow":
          int(op.index, "index", 0, ex.locations.length - 1);
          ex.locations[op.index] = xyzOf(op.xyz);
          break;
        case "addRow": {
          const at = typeof op.index === "undefined" ? ex.locations.length : int(op.index, "index", 0, ex.locations.length);
          ex.locations.splice(at, 0, xyzOf(op.xyz));
          break;
        }
        case "deleteRow":
          int(op.index, "index", 0, ex.locations.length - 1);
          ex.locations.splice(op.index, 1);
          break;
        case "split": {
          int(op.index, "index", 0, ex.locations.length - 1);
          const newId = Math.max(...exps.map((x) => x.id)) + 1;
          const moved = ex.locations.splice(op.index);
          exps.splice(idx + 1, 0, {id: newId, title: ex.title, caption: ex.caption, locations: moved, tags: [], markBadTable: {ok: 0, bad: 0}});
          changed.add(newId);
          break;
        }
        case "replaceFromText": {
          const rows = [];
          for (const line of str(op.text, "text", 0, 1e6).split("\n")) {
            const nums = (line.replace(/−/g, "-").match(/-?\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);
            if (nums.length === 3) { rows.push(nums); }
          }
          if (!rows.length) { fail(E.VALIDATION, "text has no valid line"); }
          ex.locations = rows.map((r) => r.map(fmt).join(","));
          break;
        }
        default: fail(E.VALIDATION, "unknown op");
        }
        if (ex.locations.length > 5000) { fail(E.VALIDATION, "too many rows"); }
      }
      art.Experiments = exps;
      art.rev = (art.rev || 0) + 1;

      return clone({rev: art.rev, experiments: exps.filter((x) => changed.has(x.id))});
    },

    addArticle: (p) => {
      noUnknown(p, ["pmid", "nTables"]);
      requireUser();
      const pmid = pmidOf(p.pmid);
      const n = typeof p.nTables === "undefined" ? 1 : int(p.nTables, "nTables", 0, 50);
      rateLimit("addArticle");
      if (state.articles[pmid]) { fail(E.EXISTS, "Article already exists"); }
      state.articles[pmid] = {
        objectId: `obj${pmid}`, PMID: pmid, Title: `Mock article ${pmid}`, Authors: "", Reference: "", Abstract: "",
        Metadata: {meshHeadings: []},
        Experiments: Array.from({length: n}, (_, i) => ({id: i + 1, title: "", caption: "", locations: [], tags: [], markBadTable: {ok: 0, bad: 0}})),
        rev: 0, indexed: true
      };

      return {objectId: `obj${pmid}`, pmid, indexed: true};
    },

    listCollections: (p) => {
      noUnknown(p, []);
      requireUser();

      return clone(state.collections.filter((c) => c.user === userId()).map(({id, name, pmids, updatedAt}) => ({id, name, pmids, updatedAt})));
    },

    saveCollection: (p) => {
      noUnknown(p, ["id", "name", "add", "remove"]);
      requireUser();
      rateLimit("saveCollection");
      const mine = state.collections.filter((c) => c.user === userId());
      let col;
      if (p.id) {
        col = mine.find((c) => c.id === p.id) || fail(E.NOT_FOUND, "Collection not found");
      } else {
        if (mine.length >= 50) { fail(E.VALIDATION, "too many collections (50)"); }
        col = {id: `col${++state.seq}`, user: userId(), name: "", pmids: []};
        state.collections.push(col);
      }
      if (typeof p.name !== "undefined") { col.name = str(p.name, "name", 1, 200); } else if (!p.id) { fail(E.VALIDATION, "name is required"); }
      for (const x of (p.remove || [])) { col.pmids = col.pmids.filter((y) => y !== pmidOf(x)); }
      for (const x of (p.add || [])) { if (!col.pmids.includes(pmidOf(x))) { col.pmids.push(x); } }
      if (col.pmids.length > 2000) { fail(E.VALIDATION, "too many articles (2000)"); }
      col.updatedAt = new Date(now()).toISOString();

      return {id: col.id, name: col.name, pmids: [...col.pmids], updatedAt: col.updatedAt};
    },

    deleteCollection: (p) => {
      noUnknown(p, ["id"]);
      requireUser();
      const i = state.collections.findIndex((c) => c.id === p.id && c.user === userId());
      if (i < 0) { fail(E.NOT_FOUND, "Collection not found"); }
      state.collections.splice(i, 1);

      return {id: p.id};
    },

    listConcepts: (p) => {
      noUnknown(p, ["ontology"]);
      if (!ONTOLOGIES.includes(p.ontology)) { fail(E.VALIDATION, "ontology must be cognitive, behavioural or tasks"); }

      return clone(CONCEPTS[p.ontology]);
    },

    getConcept: (p) => {
      noUnknown(p, ["name", "ontology"]);
      if (!ONTOLOGIES.includes(p.ontology)) { fail(E.VALIDATION, "ontology must be cognitive, behavioural or tasks"); }
      const c = CONCEPTS[p.ontology].find((x) => tagKey(x.name) === tagKey(str(p.name, "name", 1, 500))) || fail(E.NOT_FOUND, "Concept not found");

      return {name: c.name, ontology: p.ontology, definition: "", url: `https://example.org/${p.ontology}/${encodeURIComponent(c.name)}`};
    }
  };

  const call = async (name, params = {}) => {
    if (latency) { await sleep(latency); }
    if (typeof fns[name] !== "function") { fail(E.NOT_FOUND, `Unknown function ${name}`); }
    if (failCode && WRITES.has(name)) { fail(failCode, `Mock failure ${failCode}`); }

    return fns[name](params || {});
  };

  return {
    call,
    getArticle: async (pmid) => {
      if (latency) { await sleep(latency); }
      const a = state.articles[String(pmid)];

      return a ? clone(a) : null;
    },
    loginAs: (login) => { state.user = login || null; },
    logout: () => { state.user = null; },
    // test helpers
    _state: state,
    _asOtherUser: (login) => { state.user = login; }
  };
};
