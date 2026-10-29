/**
 * Pure state helpers for votes (no DOM): the balance class and the updates from the server's answers.
 */

/** CSS class for the balance of votes (the original coloured tags by balance). */
export const balanceClass = (agree, disagree) => {
  const total = agree + disagree;
  if (total === 0) {
    return "bal-none";
  }
  const r = (agree - disagree) / total;
  if (r > 0.5) { return "bal-good"; }
  if (r > 0) { return "bal-ok"; }
  if (r === 0) { return "bal-tie"; }
  if (r >= -0.5) { return "bal-poor"; }

  return "bal-bad";
};

const sameTag = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/** The entry of ann.votes for (kind, experimentId, ontology, tag), or null. */
export const findVote = (ann, kind, experimentId, ontology, tag) =>
  (ann && ann.votes || []).find((v) => v.kind === kind && v.experimentId === experimentId &&
    (v.ontology || null) === (ontology || null) && sameTag(v.tag, tag)) || null;

/**
 * Put the answer of vote() into ann.votes. Tags that fall to zero votes disappear (display rule of 3.4,
 * which the server applies on read); MeSH headings and tableOk entries stay.
 */
export const applyVoteResult = (ann, res) => {
  const entry = findVote(ann, res.kind, res.experimentId, res.ontology, res.tag);
  const next = {kind: res.kind, experimentId: res.experimentId, ontology: res.ontology || null, tag: res.tag,
    agree: res.agree, disagree: res.disagree, mine: res.mine};
  const keep = res.kind !== "tag" || res.agree + res.disagree >= 1;
  if (entry) {
    ann.votes.splice(ann.votes.indexOf(entry), 1, ...(keep ? [next] : []));
  } else if (keep) {
    ann.votes.push(next);
  }

  return ann;
};
