// Fold write / edit / apply_patch blocks -- and, optionally, long bash commands
// -- in the OpenCode V2 transcript.
//
// opencode already collapses bash OUTPUT to ten lines and (since V2) also trims
// a long bash COMMAND to two, both with click-to-expand. The file tools that
// produce the most scrollback -- write, edit and apply_patch -- are the ones it
// does not touch: they render the whole diff, or the whole written file,
// forever. The three upstream requests for a setting (#9089 minimal diff
// display, #14511 a toggle keybind, #19074 collapse tool output) were all
// closed without one, so this does it from a plugin.
//
// A folded block renders as its header line -- "# Wrote 40 lines · click to
// expand  src/app.ts" -- and opens on click, or with the optional `key`
// binding for every block at once.
//
// Options can live on the plugin entry in opencode.json or cli.json:
//   { "package": "@cardinal4/opencode-fold-diffs", "options": { ... } }
// opencode.json options reach the TUI through the server part's RPC bridge;
// cli.json is the local TUI's own source and wins when both set a key.
//   lines      lines of the body left visible when folded  (default 0, title only)
//   min_lines  leave blocks with fewer content lines alone  (default 6)
//   stats      append "40 lines · click to expand" to the header (default true)
//   folded     new blocks start folded                      (default true)
//   key        binding that folds/unfolds every block        (default "", none)
//   bash       fold long bash commands too                   (default false on V2)
//   bash_lines rows of the command left visible when folded  (default 1)
//
// The plugin is loaded by the OpenCode V2 CLI from the package's "./tui" export
// and receives a plugin Context (see @opencode/plugin/tui). It exports a plain
// { id, setup } definition; Plugin.define() is an identity helper, so the
// shape is the same without a runtime dependency on @opencode/plugin.

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPTIONS_RPC } from "./rpc.js";

const DEFAULTS = {
  lines: 0,
  min_lines: 6,
  stats: true,
  folded: true,
  // No binding by default: ctrl+o belongs to OpenCode's "Open recent sessions
  // and projects". Set `key` to opt in to a fold/unfold-all shortcut.
  key: "",
  // V2 collapses a long command to two lines and its output to ten, both with
  // click-to-expand, so the command is no longer the "the host never trims it"
  // gap it was in V1. Off by default; turn on to tighten it to one line.
  bash: false,
  bash_lines: 1,
  // Where "Fold diffs: diagnose" writes its tree dump. "" is the default
  // (/tmp/opencode-fold-diffs-tree.txt); false turns the dump off.
  dump: "",
};

// Header labels of the file-writing tools, as V2 renders them. Unlike V1, V2
// splits a block header into a label text node ("# Wrote", "← Edit", ...) and a
// separate path node, so these match the label alone. The stats suffix a folded
// header carries is stripped by baseLabel() before matching, so re-adopting a
// block on a later scan is idempotent.
const LABELS = ["# Wrote", "← Edit", "← Patched", "# Created", "# Deleted", "# Moved"];

function isLabel(text) {
  return LABELS.includes(text);
}

// The stats suffix this plugin appends to a folded header. Stripping it makes
// re-adopting a block idempotent: a hot reload rebuilds the plugin, re-walks the
// same transcript and must not append the suffix a second time.
const SUFFIX = / (?:\d+ lines?|\+\d+ −\d+) · click to expand$/;

function baseLabel(text) {
  const match = SUFFIX.exec(text);
  return match ? text.slice(0, match.index) : text;
}

// A shell block carries no header of its own, and V2 writes the command with a
// "$ " in front of it.
const PROMPT = "$ ";

// Events cover the live case. The fallback catches a session opened from
// history, whose parts arrive as one batch before any event this plugin sees;
// it is deliberately slower than the old 2 s timer because that batch is the
// only thing it is for.
const SWEEP_MS = 5000;

// Yoga enum values, so the 0.8 getters can be read without importing
// @opentui/core (which the host bundles and minifies).
const EDGE_TOP = 1;
const EDGE_BOTTOM = 3;
const GUTTER_ROW = 1;

// Scrollboxes that belong to the host's panels and dialogs rather than to the
// transcript. The shell viewer is the important one: since V2 it is also a
// sticky scrollbox.
const EXCLUDED_SCROLL_IDS = new Set([
  "shell-output-scroll",
  "diff-help-scroll",
  "execute-detail-scroll",
]);

const MAX_ROWS = 10000;
const BRIDGE_TIMEOUT_MS = 500;

function children(node) {
  return typeof node?.getChildren === "function" ? node.getChildren() : [];
}

function plain(node) {
  const value = node?.plainText;
  return typeof value === "string" ? value : undefined;
}

// Duck-typing, not instanceof: the classes live in the host's bundled
// @opentui/core and are minified, so their names are not stable. A diff
// renderable is the only thing in the tree carrying a `diff` string. A code
// renderable is a TextBufferRenderable: its `content` is a string AND it
// exposes the line map. MarkdownRenderable also has a string `content`, so
// checking the content alone made a markdown block look like a written file.
function isDiff(node) {
  return typeof node?.diff === "string";
}

function isCode(node) {
  return typeof node?.content === "string" && typeof node?.getLineSources === "function";
}

// The text renderable's value is a styled-text object, not a string. Text is
// the one primitive here that every host version has kept.
function textValue(node) {
  return typeof node?.content === "string" ? node.content : undefined;
}

// The stable identity of a message part, if the host published one. V2 sets
// `session-part:<messageID>:<partID>` on the part container; older trees at
// least carry a `msg_` id. Walking parents keeps this working when the block
// renderable itself has no id.
function stableKey(node) {
  let current = node;
  for (let i = 0; current && i < 200; i++) {
    const id = typeof current.id === "string" ? current.id : "";
    if (id.startsWith("session-part:") || id.startsWith("msg_")) return id;
    current = current.parent;
  }
  return undefined;
}

// Rows a text content occupies. A lone "\n" is one empty line, not zero; a
// single trailing newline is the terminator and does not add a second line.
function contentLines(content) {
  if (content === "") return 0;
  const lines = content.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

// A real unified-diff file header is the three-character marker followed by a
// space and a path. Without the space requirement a content line whose text
// starts "+++" was silently dropped from the stats.
function isDiffHeader(line) {
  if (!line.startsWith("+++ ") && !line.startsWith("--- ")) return false;
  return line.slice(4).trim().length > 0;
}

// The command text of a bash block, or nothing. V2 wraps the command and its
// output in one box. The command is the first text-bearing child of that box;
// only an empty <Show> placeholder may precede it.
//
// Scanning every grandchild for "$ " was wrong in two ways: while a command is
// still running the host puts it in a row next to a spinner (no "$ " yet), and
// its output may legitimately begin with "$ " -- which the old code then folded
// instead of the command. A non-leaf before the text or an unprefixed first
// text means this is a running/other block, not an adoptable shell block.
function shellCommand(block) {
  for (const child of children(block)) {
    const inner = children(child);
    // command plus at least its output/hint sibling
    if (inner.length < 2) continue;
    for (const node of inner) {
      const text = plain(node);
      if (typeof text === "string") {
        return text.startsWith(PROMPT) ? { node, text } : undefined;
      }
      // A spinner/command row is a box, not a leaf placeholder. Wait for a
      // later sweep, once the command is rendered as text with its prompt.
      if (children(node).length) return undefined;
    }
  }
  return;
}

// Rows the command occupies, not lines it contains: a single-line command long
// enough to wrap is exactly the kind worth folding. `height` is the laid-out
// row count, but the host already clamps it to two, so it can never prove a
// long command is long. The intrinsic height comes from the text width instead.
function commandRows(node, text) {
  const lines = text.split("\n");
  let rows = lines.length;
  const width =
    typeof node?.width === "number" && Number.isFinite(node.width) ? Math.trunc(node.width) : 0;
  if (width > 0 && node?.wrapMode !== "none") {
    let wrapped = 0;
    for (const line of lines) wrapped += Math.max(1, Math.ceil(line.length / width));
    rows = Math.max(rows, wrapped);
  }
  const height =
    typeof node?.height === "number" && Number.isFinite(node.height) ? node.height : 0;
  return Math.max(rows, height);
}

function bulk(node, found = []) {
  if (!node || node.isDestroyed) return found;
  if (isDiff(node) || isCode(node)) {
    found.push(node);
    return found;
  }
  for (const child of children(node)) bulk(child, found);
  return found;
}

// The session transcript is a scrollbox that sticks to the bottom. It is not
// the only one: the shell output viewer, the diff help panel and the execute
// detail panel are scrollboxes too. They are excluded by id, and the remaining
// candidates are scored by session-part descendants and scroll height rather
// than taking the first match.
function isScrollbox(node) {
  try {
    return typeof node?.scrollTo === "function" && typeof node?.scrollHeight === "number";
  } catch {
    return false;
  }
}

function excludedScrollbox(node) {
  const id = typeof node?.id === "string" ? node.id : "";
  if (!id) return false;
  if (EXCLUDED_SCROLL_IDS.has(id)) return true;
  return /(?:^|[-_])(dialog|panel|popup|viewer)(?:$|[-_])/.test(id);
}

// Bit flags: 1 = a session-part id, 2 = a message id. Collected bottom-up in
// one walk so each scrollbox only sees evidence inside its own subtree.
function collectScrollboxes(node, found, depth = 0) {
  if (!node || node.isDestroyed || depth > 1000) return 0;
  const id = typeof node.id === "string" ? node.id : "";
  let flags = id.startsWith("session-part:") ? 1 : id.startsWith("msg_") ? 2 : 0;
  for (const child of children(node)) flags |= collectScrollboxes(child, found, depth + 1);
  if (isScrollbox(node) && !excludedScrollbox(node)) found.push({ node, flags });
  return flags;
}

function transcriptScore(node, flags) {
  const sticky = node.stickyScroll === true;
  const bottom = node.stickyStart === "bottom";
  // Scrolled up, the host can report stickyScroll=false; a bottom anchor plus
  // session-part evidence is still enough to identify the transcript.
  if (!sticky && !(bottom && flags)) return -Infinity;
  let score = 0;
  if (flags & 1) score += 1000;
  if (flags & 2) score += 600;
  if (sticky) score += 50;
  if (bottom) score += 50;
  if (typeof node.scrollHeight === "number" && Number.isFinite(node.scrollHeight)) {
    score += Math.min(100, Math.max(0, Math.log2(node.scrollHeight + 1) * 4));
  }
  return score;
}

function findTranscript(root) {
  const found = [];
  collectScrollboxes(root, found);
  let best;
  let bestScore = -Infinity;
  for (const candidate of found) {
    const score = transcriptScore(candidate.node, candidate.flags);
    if (score > bestScore) {
      best = candidate.node;
      bestScore = score;
    }
  }
  return best;
}

// A V2 BlockTool renders the header first: a row box whose first two children
// are the label text ("# Wrote") and the path value. Anything else is not one
// of ours. The row is returned with the label node so a folded header can be
// restated with its stats.
function blockHeader(block) {
  for (const row of children(block)) {
    const rowKids = children(row);
    // Label plus the path value. The guard also keeps the plain-text read --
    // which rebuilds a string every call -- off the leaf nodes, and the
    // transcript is mostly leaf nodes.
    if (rowKids.length < 2) continue;
    // <Show> may leave childless placeholders around the label, so scan the
    // row for the label rather than assume it is the first child. It must still
    // have a sibling after it: that is the path value.
    for (let i = 0; i < rowKids.length - 1; i++) {
      const label = plain(rowKids[i]);
      if (typeof label !== "string") continue;
      const base = baseLabel(label);
      if (!isLabel(base)) continue;
      return { row, node: rowKids[i], label: base };
    }
  }
  return;
}

function scan(node, hits = [], shell = false) {
  if (!node || node.isDestroyed) return hits;
  // A matched block never contains another one, so stop descending.
  if (blockHeader(node) || (shell && shellCommand(node))) {
    hits.push(node);
    return hits;
  }
  for (const child of children(node)) scan(child, hits, shell);
  return hits;
}

// "+12 −3" from a unified diff, "42 lines" from a written file. Counted off the
// renderable's own props, so it stays right even for parts the TUI store has
// already dropped.
function summarise(nodes) {
  let added = 0;
  let removed = 0;
  let lines = 0;
  let diffs = 0;
  for (const node of nodes) {
    if (!node || node.isDestroyed) continue;
    if (isDiff(node)) {
      diffs++;
      const lines = node.diff.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // A file header is the marker plus a path, and the --- / +++ pair is
        // what distinguishes it from a content line that merely starts with
        // the same characters.
        if (isDiffHeader(line)) {
          const previous = lines[i - 1];
          const next = lines[i + 1];
          if (line.startsWith("--- ") && next && isDiffHeader(next) && next.startsWith("+++ ")) {
            continue;
          }
          if (
            line.startsWith("+++ ") &&
            previous &&
            isDiffHeader(previous) &&
            previous.startsWith("--- ")
          ) {
            continue;
          }
        }
        if (line.startsWith("+")) added++;
        else if (line.startsWith("-")) removed++;
      }
      continue;
    }
    lines += contentLines(textValue(node) ?? "");
  }
  if (diffs) return { size: added + removed, label: `+${added} −${removed}` };
  return { size: lines, label: `${lines} ${lines === 1 ? "line" : "lines"}` };
}

// --- host style ----------------------------------------------------------
//
// Setter-only props in 0.5 became getters in OpenTUI 0.8. Capture what the host
// actually set instead of assuming BlockTool's values, then put it back when a
// block unfolds or the plugin is disabled.

function readStyle(node, getter, args, property, fallback) {
  try {
    if (typeof node?.[getter] === "function") {
      const value = node[getter](...args);
      if (value !== undefined) return value;
    }
  } catch {}
  try {
    const value = node?.[property];
    if (value !== undefined) return value;
  } catch {}
  return fallback;
}

function maxHeightOf(node, fallback) {
  const value = readStyle(node, "getMaxHeight", [], "maxHeight", fallback);
  // "auto" is the unset value in Yoga. For a shell command the host's real
  // clamp (two rows) is the better restore point than an explicit auto.
  return value === "auto" ? fallback : value;
}

function chromeOf(node) {
  return {
    gap: readStyle(node, "getGap", [GUTTER_ROW], "gap", 1),
    paddingTop: readStyle(node, "getPadding", [EDGE_TOP], "paddingTop", 1),
    paddingBottom: readStyle(node, "getPadding", [EDGE_BOTTOM], "paddingBottom", 1),
  };
}

// --- options -------------------------------------------------------------

function plainOptions(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function integerOption(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(MAX_ROWS, Math.max(0, Math.trunc(number)));
}

function describeOptions(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "?";
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    let done = false;
    let timer;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => finish(undefined), ms);
    Promise.resolve(promise).then(finish, () => finish(undefined));
  });
}

// Best-effort: the server part answers with the options OpenCode gave it from
// opencode.json. A missing/older server or a host without portable RPC just
// leaves the cli.json values (possibly none) in place.
async function bridgeOptions(context) {
  try {
    if (typeof context?.client?.rpc !== "function") return {};
    const client = context.client.rpc(OPTIONS_RPC);
    if (typeof client?.get !== "function") return {};
    const result = await withTimeout(client.get({}), BRIDGE_TIMEOUT_MS);
    const options = plainOptions(result?.options);
    return options;
  } catch {
    return {};
  }
}

// Debug-only: one line per renderable, for aligning the matcher with a real
// transcript when a live run reports `blocks: 0`. Truncated so a big session
// still writes quickly.
function dumpNode(node, depth, lines, limit) {
  if (!node || node.isDestroyed || lines.length >= limit) return;
  const kids = children(node);
  const text = plain(node);
  const tags = [];
  if (isDiff(node)) tags.push("diff");
  if (isCode(node)) tags.push("code");
  if (node.stickyScroll === true) tags.push("sticky");
  lines.push(
    `${"  ".repeat(depth)}${node.constructor?.name ?? "node"} kids=${kids.length}` +
      (typeof text === "string" ? ` text=${JSON.stringify(text.slice(0, 80))}` : "") +
      (tags.length ? ` [${tags.join(",")}]` : "") +
      ` vis=${node.visible} h=${node.height} ov=${node.overflow}`,
  );
  for (const kid of kids) dumpNode(kid, depth + 1, lines, limit);
}

// 2.0.23 was the first V2 release whose `keymap.layer` may be called from
// setup; before that it reads Solid context and needs a mounted component.
// An unparseable version takes the fallback, which works on every V2 build.
function supportsSetupKeymap(version) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? ""));
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 2 || (major === 2 && (minor > 0 || patch >= 23));
}

export const PLUGIN_ID = "opencode-fold-diffs";

export default {
  id: PLUGIN_ID,
  async setup(context) {
    const cliOptions = plainOptions(context.options);
    const serverOptions = await bridgeOptions(context);
    // cli.json is the local TUI's own configuration and wins on a conflict;
    // opencode.json supplies everything it does not set.
    const opts = { ...DEFAULTS, ...serverOptions, ...cliOptions };
    const peek = integerOption(opts.lines, DEFAULTS.lines);
    const floor = integerOption(opts.min_lines, DEFAULTS.min_lines);
    const shell = opts.bash === true;
    const shellPeek = integerOption(opts.bash_lines, DEFAULTS.bash_lines);
    const key = typeof opts.key === "string" ? opts.key : "";

    // Folded state by stable part id, so a block that is remounted keeps the
    // mode it was toggled to. WeakMap state below is per-renderable and dies
    // with the renderable; this Map is the part's memory.
    const foldedByKey = new Map();
    const known = new WeakMap();
    // WeakMap has no iterator, so keep a strong set of adopted blocks only for
    // cleanup. Destroyed blocks are pruned on the sweep to avoid retaining a
    // closed session's renderables.
    const adopted = new Set();
    // The mode new blocks adopt. ctrl+o flips it, so "expand everything" also
    // means "and stop folding what arrives next", the way a verbose toggle works.
    let folding = opts.folded !== false;
    // Set once the header rewrite is proven not to take, so we stop retrying it.
    let titles = opts.stats !== false;
    let disposed = false;

    let cached;
    let routed;

    function currentRoute() {
      try {
        return context.ui.router.current();
      } catch {
        return undefined;
      }
    }

    // Route/session changes destroy or replace the transcript and invalidate
    // per-session fold memory. Detecting it here also makes the cache safe to
    // keep between the (now much slower) fallback sweeps.
    function refreshRoute() {
      const route = currentRoute();
      const token =
        route?.type === "session" ? `session:${route.sessionID ?? ""}` : String(route?.type ?? "");
      if (token !== routed) {
        routed = token;
        cached = undefined;
        foldedByKey.clear();
      }
      return token;
    }

    function attached(node) {
      const root = context.renderer.root;
      let current = node;
      for (let i = 0; current && i < 2000; i++) {
        if (current === root) return true;
        current = current.parent;
      }
      return false;
    }

    function transcript() {
      refreshRoute();
      if (cached && !cached.isDestroyed && attached(cached)) return cached;
      cached = findTranscript(context.renderer.root);
      return cached;
    }

    function setTitle(state, fold) {
      if (!state.title) return;
      const next = fold && titles ? `${state.text} ${state.suffix}` : state.text;
      if (plain(state.title) === next) {
        state.titleChanged = fold && titles;
        return;
      }
      try {
        state.title.content = next;
      } catch {
        titles = false;
        return;
      }
      const applied = plain(state.title);
      if (fold && titles) {
        if (applied === next) state.titleChanged = true;
        else titles = false;
      } else {
        state.titleChanged = applied !== state.text;
      }
    }

    function apply(state, fold) {
      state.body.forEach((node, index) => {
        try {
          // `visible = false` sets Yoga display:none, which removes the body
          // from layout entirely. A zero max-height alone was not enough: Yoga
          // clamped the box to zero rows but OpenTUI still painted the diff.
          // A positive `lines` peek keeps the first body visible instead.
          const peekRow = fold && index === 0 && state.peek > 0;
          node.visible = fold ? peekRow : (state.visible[index] ?? true);
          node.maxHeight = peekRow ? state.peek : state.maxHeight[index];
          node.overflow = fold ? "hidden" : state.overflow[index];
        } catch {}
      });
      // With the body at zero height the block's own padding and the gap it
      // keeps between children are all that is left. Collapse the chrome too so
      // a folded block reads as the single row it now is, restoring exactly the
      // values the host had rather than BlockTool's assumed 1/1/1. Never for a
      // shell block: its output is a sibling of the command and stays on screen,
      // so the chrome is still holding something up.
      if (state.chrome) {
        try {
          state.block.gap = fold ? 0 : state.chromeStyle.gap;
          state.block.paddingTop = fold ? 0 : state.chromeStyle.paddingTop;
          state.block.paddingBottom = fold ? 0 : state.chromeStyle.paddingBottom;
        } catch {}
      }
      // Restore the label even after `titles` was turned off globally: a block
      // whose suffix was applied before the failure must not keep it.
      setTitle(state, fold);
    }

    function setFolded(state, fold) {
      state.folded = fold;
      if (state.key) foldedByKey.set(state.key, fold);
      apply(state, fold);
    }

    function selection() {
      try {
        return context.renderer.getSelection?.()?.getSelectedText?.();
      } catch {
        return undefined;
      }
    }

    function installHandler(state, target, stop) {
      state.handlerTarget = target;
      state.handler = (event) => {
        if (disposed || state.block.isDestroyed) return;
        // Copy-on-select is a drag ending on the block; that is not a click.
        if (selection()) return;
        setFolded(state, !state.folded);
        if (stop) event?.stopPropagation?.();
      };
      target.onMouseUp = state.handler;
    }

    function adoptDiff(block) {
      const header = blockHeader(block);
      if (!header) return false;
      // Everything after the header that actually carries a diff or a file
      // body. Diagnostics and the error line carry neither, so an edit that
      // broke the build still says so while folded.
      const body = [];
      const heavy = [];
      for (const child of children(block)) {
        if (child === header.row) continue;
        const found = bulk(child);
        if (!found.length) continue;
        body.push(child);
        heavy.push(...found);
      }
      if (!body.length) return false;
      const stats = summarise(heavy);
      if (stats.size < floor) return false;

      const state = {
        block,
        body,
        visible: body.map((node) => node.visible),
        maxHeight: body.map((node) => maxHeightOf(node, undefined)),
        overflow: body.map((node) => node.overflow),
        title: header.node,
        text: header.label,
        suffix: `${stats.label} · click to expand`,
        signature: `${stats.size}|${stats.label}`,
        peek,
        chrome: peek === 0,
        chromeStyle: chromeOf(block),
        folded: false,
        titleChanged: false,
        key: stableKey(block),
        kind: "diff",
      };
      const remembered = state.key === undefined ? undefined : foldedByKey.get(state.key);
      state.folded = remembered === undefined ? folding : remembered;
      if (state.key !== undefined) foldedByKey.set(state.key, state.folded);
      known.set(block, state);
      adopted.add(block);
      installHandler(state, block, false);
      apply(state, state.folded);
      return true;
    }

    function adoptShell(block) {
      const found = shellCommand(block);
      if (!found) return false;
      if (commandRows(found.node, found.text) < floor) return false;

      const state = {
        block,
        body: [found.node],
        visible: [found.node.visible],
        // The host clamps a running/long command to two rows. If the getter is
        // unavailable, two is still a better restore point than undefined.
        maxHeight: [maxHeightOf(found.node, 2)],
        overflow: [found.node.overflow],
        title: undefined,
        text: "",
        suffix: "",
        signature: "",
        peek: shellPeek,
        chrome: false,
        chromeStyle: undefined,
        folded: false,
        titleChanged: false,
        key: stableKey(block),
        kind: "shell",
      };
      const remembered = state.key === undefined ? undefined : foldedByKey.get(state.key);
      state.folded = remembered === undefined ? folding : remembered;
      if (state.key !== undefined) foldedByKey.set(state.key, state.folded);
      known.set(block, state);
      adopted.add(block);

      // The block's own onMouseUp belongs to the host here -- it is what expands
      // the collapsed command/output -- and opentui declares the handler as a
      // setter with no getter, so it cannot be read back and chained. Take the
      // command text instead and stop the event on it: clicking the command
      // folds the command, clicking anywhere else in the block still does
      // exactly what it did before this plugin loaded.
      installHandler(state, found.node, true);
      apply(state, state.folded);
      return true;
    }

    function adopt(block) {
      if (adoptDiff(block)) return true;
      if (shell) return adoptShell(block);
      return false;
    }

    // Recompute a folded block's stats without dropping its adoption. A tool
    // that streams more content into the same renderables used to keep the
    // first summary forever because the sweep skipped every known block.
    function refreshStats(state) {
      if (state.kind !== "diff") return;
      const heavy = [];
      for (const child of state.body) bulk(child, heavy);
      if (!heavy.length) return;
      const stats = summarise(heavy);
      const signature = `${stats.size}|${stats.label}`;
      if (signature === state.signature) return;
      state.signature = signature;
      state.suffix = `${stats.label} · click to expand`;
      if (state.folded) setTitle(state, true);
    }

    function sweep() {
      if (disposed) return;
      for (const block of adopted) {
        if (block.isDestroyed) {
          adopted.delete(block);
          continue;
        }
        const state = known.get(block);
        if (state) refreshStats(state);
      }
      if (!refreshRoute().startsWith("session:")) return;
      const box = transcript();
      if (!box) return;
      for (const block of scan(box, [], shell)) {
        if (known.has(block)) continue;
        adopt(block);
      }
    }

    function all(fold) {
      folding = fold;
      const box = transcript();
      if (!box) return 0;
      let count = 0;
      for (const block of scan(box, [], shell)) {
        const state = known.get(block);
        if (!state || state.folded === fold) continue;
        setFolded(state, fold);
        count++;
      }
      return count;
    }

    let pending;
    function schedule() {
      if (disposed || pending) return;
      pending = setTimeout(() => {
        pending = undefined;
        sweep();
      }, 120);
    }

    // V1's message.part.updated / message.updated are legacy schemas in V2 --
    // the client emits the session.* events instead. `session.message.content.
    // updated` is not exposed by the public TUI event union, so the tool events
    // (plus the step and execution endings) are the ones this plugin can rely
    // on; the slow fallback sweep covers anything else.
    const events = [
      "session.tool.called", // a tool block was added to the transcript
      "session.tool.progress", // its body may have grown or changed
      "session.tool.success", // a tool body (diff or file) is final
      "session.tool.failed", // a failed tool still renders its block
      "session.step.ended", // the step's final content has arrived
      "session.execution.succeeded", // the turn settled; take a final look
    ];
    if (shell) events.push("session.shell.ended"); // the command now carries its "$ " prefix
    // An older host may not know every event name; a missing subscription must
    // not take the whole plugin down.
    const offs = events.map((name) => {
      try {
        return context.data.on(name, schedule);
      } catch {
        return undefined;
      }
    });
    const timer = setInterval(sweep, SWEEP_MS);
    schedule();

    // The command layer itself is identical everywhere; only who registers it
    // differs. 2.0.23+ runs `keymap.layer` from setup and owns its teardown.
    // Older V2 reads Solid context when registering, so there the layer has to
    // be created by a mounted component. The `app` slot supplies one.
    function registerCommands() {
      context.keymap.layer(() => ({
        mode: "global",
        priority: 100,
        commands: [
          {
            id: "opencode-fold-diffs.toggle",
            title: "Fold / unfold file diffs",
            group: "Plugin",
            palette: true,
            bind: key || false,
            run() {
              if (disposed) return;
              sweep();
              const fold = !folding;
              const changed = all(fold);
              context.ui.toast.show({
                variant: "info",
                message: changed
                  ? `${fold ? "Folded" : "Unfolded"} ${changed} ${changed === 1 ? "block" : "blocks"}`
                  : `New file blocks will be ${fold ? "folded" : "unfolded"}`,
                duration: 2000,
              });
            },
          },
          {
            // Reports what the plugin can see, so "nothing happens" can be told
            // apart from "no transcript yet" or "blocks not matched".
            id: "opencode-fold-diffs.diagnose",
            title: "Fold diffs: diagnose",
            group: "Plugin",
            palette: true,
            run() {
              if (disposed) return;
              const inSession = refreshRoute().startsWith("session:");
              const box = inSession ? transcript() : undefined;
              const blocks = box ? scan(box, [], shell) : [];
              const folded = blocks.filter((block) => known.get(block)?.folded).length;
              const options = describeOptions(opts);
              let dump;
              try {
                const summary = [
                  `transcript=${Boolean(box)} blocks=${blocks.length} folded=${folded} stats=${titles ? "on" : "off"} options=${options}`,
                ];
                for (const block of blocks) {
                  const state = known.get(block);
                  const head = blockHeader(block);
                  summary.push(
                    `block "${head?.label ?? "?"}" folded=${state?.folded} body=[` +
                      (state?.body ?? [])
                        .map((node) => `${node.constructor?.name}(vis=${node.visible},ov=${node.overflow})`)
                        .join(", ") +
                      "]",
                  );
                }
                const target =
                  opts.dump === false
                    ? undefined
                    : typeof opts.dump === "string" && opts.dump
                      ? opts.dump
                      : join(tmpdir(), "opencode-fold-diffs-tree.txt");
                if (target) {
                  const lines = [];
                  dumpNode(box ?? context.renderer.root, 0, lines, 600);
                  writeFileSync(target, summary.concat("", lines).join("\n"));
                  // Only advertise the path once the write succeeded; the
                  // catch below keeps a failed write from taking down diagnose.
                  dump = target;
                }
              } catch {}
              context.ui.toast.show({
                title: "opencode-fold-diffs",
                variant: box ? "info" : "warning",
                duration: 5000,
                message: box
                  ? `transcript: yes · blocks: ${blocks.length} · folded: ${folded} · stats: ${titles ? "on" : "off"} · options: ${options}` +
                    (dump ? ` · dump: ${dump}` : "")
                  : `transcript: not found — open a session first · options: ${options}`,
              });
            },
          },
        ],
        bindings: key ? ["opencode-fold-diffs.toggle"] : [],
      }));
    }
    let stopCommands = () => {};
    const registerCommandsSafely = () => {
      try {
        registerCommands();
      } catch {}
    };
    if (supportsSetupKeymap(context.app?.version)) {
      registerCommandsSafely();
    } else {
      function FoldCommands() {
        registerCommandsSafely();
        return null;
      }
      try {
        stopCommands = context.ui.slot({ append: "app", render: () => FoldCommands() });
      } catch {}
    }

    return () => {
      if (disposed) return;
      disposed = true;
      if (typeof stopCommands === "function") stopCommands();
      clearInterval(timer);
      if (pending) {
        clearTimeout(pending);
        pending = undefined;
      }
      for (const off of offs) if (typeof off === "function") off();
      // The host owns these renderables and keeps them after the plugin is
      // disabled, so undo our folds and remove our handlers instead of leaving
      // the transcript collapsed or a late click able to re-fold it.
      for (const block of adopted) {
        const state = known.get(block);
        if (!state) continue;
        try {
          if (state.handlerTarget) state.handlerTarget.onMouseUp = undefined;
        } catch {}
        if (state.folded || state.titleChanged) apply(state, false);
      }
      adopted.clear();
      foldedByKey.clear();
      cached = undefined;
    };
  },
};
