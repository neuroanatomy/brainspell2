/**
 * F5: comments. The newest 200 come with getAnnotations (oldest first); posting is for logged-in
 * users and the list is updated from the answer of postComment.
 */
import {el, setChildren} from "./dom.js";
import {createStatus, runAction} from "./context.js";

export const MAX_COMMENT = 5000;

export const formatDate = (iso) => {
  const d = new Date(iso);

  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 16).replace("T", " ");
};

/** Trimmed text if it can be posted, else null. */
export const validComment = (s) => {
  const t = String(s).trim();

  return t.length >= 1 && t.length <= MAX_COMMENT ? t : null;
};

export const renderComments = (ctx) => {
  const heading = el("h2", null, "Discussion");
  const list = el("ul", {class: "comment-list"});
  const box = el("div", {class: "comment-box"});
  const area = el("textarea", {class: "comment-text", rows: "3", maxlength: String(MAX_COMMENT), placeholder: "Write a comment…", "aria-label": "Comment"});
  const status = createStatus();
  const post = el("button", {type: "button", class: "btn-primary", onclick: async () => {
    const t = validComment(area.value);
    if (t === null) {
      status.error({code: 142, message: `a comment has 1 to ${MAX_COMMENT} characters`});

      return;
    }
    const res = await runAction(status, () => ctx.call("postComment", {pmid: ctx.pmid, text: t}));
    if (res) {
      ctx.ann.comments.push(res);
      ctx.ann.commentCount = (ctx.ann.commentCount || 0) + 1;
      if (ctx.ann.comments.length > 200) {
        ctx.ann.comments.shift();
      }
      area.value = "";
      ctx.notify();
    }
  }}, "Post comment");
  status.watch([post, area]);
  setChildren(box, area, post, status.element);
  const root = el("div", {class: "comments"}, heading, list, box);

  const update = () => {
    const comments = ctx.ann.comments || [];
    const total = ctx.ann.commentCount || comments.length;
    setChildren(heading, "Discussion", total ? ` (${total})` : "");
    setChildren(list, comments.length ? comments.map((c) => el("li", {class: "comment"},
      el("div", {class: "comment-head"},
        el("a", {href: `https://github.com/${encodeURIComponent(c.login)}`, target: "_blank", rel: "noopener"}, c.login),
        el("span", {class: "muted"}, ` ${formatDate(c.createdAt)}`)),
      el("div", {class: "comment-body"}, c.text)))
      : el("li", {class: "muted"}, "No comments yet"),
    total > comments.length ? el("li", {class: "muted"}, `Showing the newest ${comments.length} of ${total}`) : null);
    box.hidden = !ctx.canWrite();
  };
  ctx.subscribe(update);
  update();

  return root;
};
