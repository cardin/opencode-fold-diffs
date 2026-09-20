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
// expand  src/app.ts" -- and opens on click, or with ctrl+o for every block at
// once.
//
// Options (cli.json -> ["opencode-fold-diffs", { ... }] or opencode.json(c)):
//   lines      lines of the body left visible when folded  (default 0, title only)
//   min_lines  leave blocks with fewer content lines alone  (default 6)
//   stats      append "40 lines · click to expand" to the header (default true)
//   folded     new blocks start folded                      (default true)
//   key        binding that folds/unfolds every block        (default "ctrl+o")
//   bash       fold long bash commands too                   (default false on V2)
//   bash_lines rows of the command left visible when folded  (default 1)
//
// The plugin is loaded by the OpenCode V2 CLI from the package's "./tui" export
// and receives a plugin Context (see @opencode/plugin/tui). It exports a plain
// { id, setup } definition; Plugin.define() is an identity helper, so the
// shape is the same without a runtime dependency on @opencode/plugin.

const DEFAULTS = {
  lines: 0,
  min_lines: 6,
  stats: true,
  folded: true,
  key: "ctrl+o",
  // V2 collapses a long command to two lines and its output to ten, both with
  // click-to-expand, so the command is no longer the "the host never trims it"
  // gap it was in V1. Off by default; turn on to tighten it to one line.
  bash: false,
  bash_lines: 1,
};

// Header labels of the file-writing tools, as V2 renders them. Unlike V1, V2
// splits a block header into a label text node ("# Wrote", "← Edit", ...) and a
// separate path node, so these match the label alone. The trailing alternation
// keeps a header that already carries the stats suffix matching on later scans.
const LABELS = ["# Wrote", "← Edit", "← Patched", "# Created", "# Deleted", "# Moved"];

function isLabel(text) {
  return LABELS.some((label) => text === label || text.startsWith(label + " "));
}

// A shell block carries no header of its own, and V2 writes the command with a
// "$ " in front of it.
const PROMPT = "$ ";

// How often to re-scan when nothing is streaming. Events cover the live case;
// this catches a session opened from history, whose parts arrive as one batch
// before any event this plugin sees.
const SWEEP_MS = 2000;

function children(node) {
  return typeof node?.getChildren === "function" ? node.getChildren() : [];
}

function plain(node) {
  const value = node?.plainText;
  return typeof value === "string" ? value : undefined;
}

// Duck-typing, not instanceof: the classes live in the host's bundled
// @opentui/core and are minified, so their names are not stable. A diff
// renderable is the only thing in the tree carrying a `diff` string, and a code
// renderable the only thing pairing `content` with `filetype`.
function isDiff(node) {
  return typeof node?.diff === "string";
}

function isCode(node) {
  return typeof node?.content === "string" && typeof node?.filetype === "string";
}

// The command text of a bash block, or nothing. V2 wraps the command and its
// output in one box, and the command is the first child of that box prefixed
// with "$ ". While the tool is still running the host renders the command in a
// row next to a spinner, so a running command is skipped and picked up by a
// later sweep once it settles.
function shellCommand(block) {
  for (const child of children(block)) {
    const inner = children(child);
    if (!inner.length) continue;
    // solid's <Show> leaves childless placeholders, so scan rather than assume
    // the command is the first grandchild.
    for (const node of inner) {
      const text = plain(node);
      if (typeof text === "string" && text.startsWith(PROMPT)) return { node, text };
    }
  }
  return;
}

// Rows the command occupies, not lines it contains: a single-line command long
// enough to wrap is exactly the kind worth folding. `height` is the laid-out
// row count and reads 0 before the first layout, so the line count is the floor.
function commandRows(node, text) {
  const height = typeof node?.height === "number" ? node.height : 0;
  return Math.max(text.split("\n").length, height);
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

// The transcript is the only scrollbox in the TUI that asks to stick to the
// bottom. Staying inside it is what keeps the permission dialog's diff preview
// untouched -- you should always see in full what you are about to approve.
function isTranscript(node) {
  return (
    typeof node?.scrollTo === "function" &&
    typeof node?.scrollHeight === "number" &&
    node.stickyScroll === true &&
    node.stickyStart === "bottom"
  );
}

function findTranscript(node) {
  if (!node || node.isDestroyed) return;
  if (isTranscript(node)) return node;
  if (typeof node.scrollTo === "function") return;
  for (const child of children(node)) {
    const hit = findTranscript(child);
    if (hit) return hit;
  }
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
      if (typeof label !== "string" || !isLabel(label)) continue;
      return { row, node: rowKids[i], label };
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
    if (isDiff(node)) {
      diffs++;
      for (const line of node.diff.split("\n")) {
        if (line.startsWith("+++") || line.startsWith("---")) continue;
        if (line.startsWith("+")) added++;
        else if (line.startsWith("-")) removed++;
      }
      continue;
    }
    lines += node.content.split("\n").length;
  }
  if (diffs) return { size: added + removed, label: `+${added} −${removed}` };
  return { size: lines, label: `${lines} ${lines === 1 ? "line" : "lines"}` };
}

export const PLUGIN_ID = "opencode-fold-diffs";

export default {
  id: PLUGIN_ID,
  setup(context) {
    const opts = { ...DEFAULTS, ...(context.options ?? {}) };
    const peek = Math.max(0, Number(opts.lines) || 0);
    const floor = Math.max(0, Number(opts.min_lines) || 0);
    const shell = opts.bash === true;
    const shellPeek = Math.max(0, Number(opts.bash_lines) || 0);

    // Folded blocks, by their block renderable. WeakMap so a session switch,
    // which destroys the renderables, drops the state with them.
    const known = new WeakMap();
    // The mode new blocks adopt. ctrl+o flips it, so "expand everything" also
    // means "and stop folding what arrives next", the way a verbose toggle works.
    let folding = opts.folded !== false;
    // Set once the header rewrite is proven not to take, so we stop retrying it.
    let titles = opts.stats !== false;

    let cached;
    function transcript() {
      if (cached && !cached.isDestroyed) return cached;
      cached = findTranscript(context.renderer.root);
      return cached;
    }

    function apply(state, fold) {
      state.folded = fold;
      state.body.forEach((node, index) => {
        try {
          // Yoga honours a 0 max-height, so the body disappears from layout
          // entirely rather than leaving a gap where it used to be.
          node.maxHeight = fold ? (index === 0 ? state.peek : 0) : undefined;
          node.overflow = fold ? "hidden" : state.overflow[index];
        } catch {}
      });
      // With the body at zero height, the block's own padding and the gap it
      // keeps between children are all that is left. Collapse the chrome too so
      // a folded block reads as the single row it now is. The restored values
      // are BlockTool's own (paddingTop/Bottom 1, gap 1) because opentui gives
      // these setters no getters to read the originals back from. Never for a
      // shell block: its output is a sibling of the command and stays on screen,
      // so the chrome is still holding something up.
      if (state.chrome) {
        try {
          state.block.gap = fold ? 0 : 1;
          state.block.paddingTop = fold ? 0 : 1;
          state.block.paddingBottom = fold ? 0 : 1;
        } catch {}
      }
      if (!titles || !state.title) return;
      const next = fold ? `${state.text} ${state.suffix}` : state.text;
      try {
        state.title.content = next;
      } catch {
        titles = false;
        return;
      }
      // The host owns that text node. If solid is not letting go of it there is
      // nothing to be gained by asking again on every block.
      if (plain(state.title) !== next) titles = false;
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
        overflow: body.map((node) => node.overflow),
        title: header.node,
        text: header.label,
        suffix: `${stats.label} · click to expand`,
        peek,
        chrome: peek === 0,
        folded: false,
      };
      known.set(block, state);

      block.onMouseUp = () => {
        // Copy-on-select is a drag ending on the block; that is not a click.
        if (context.renderer.getSelection?.()?.getSelectedText?.()) return;
        apply(state, !state.folded);
      };

      if (folding) apply(state, true);
      return true;
    }

    function adoptShell(block) {
      const found = shellCommand(block);
      if (!found) return;
      if (commandRows(found.node, found.text) < floor) return;

      const state = {
        block,
        body: [found.node],
        overflow: [found.node.overflow],
        title: undefined,
        peek: shellPeek,
        chrome: false,
        folded: false,
      };
      known.set(block, state);

      // The block's own onMouseUp belongs to the host here -- it is what expands
      // the collapsed command/output -- and opentui declares the handler as a
      // setter with no getter, so it cannot be read back and chained. Take the
      // command text instead and stop the event on it: clicking the command
      // folds the command, clicking anywhere else in the block still does
      // exactly what it did before this plugin loaded.
      found.node.onMouseUp = (event) => {
        if (context.renderer.getSelection?.()?.getSelectedText?.()) return;
        apply(state, !state.folded);
        event?.stopPropagation?.();
      };

      if (folding) apply(state, true);
    }

    function adopt(block) {
      if (adoptDiff(block)) return;
      if (shell) adoptShell(block);
    }

    function sweep() {
      if (context.ui.router.current().type !== "session") return;
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
        apply(state, fold);
        count++;
      }
      return count;
    }

    let pending;
    function schedule() {
      if (pending) return;
      pending = setTimeout(() => {
        pending = undefined;
        sweep();
      }, 120);
    }

    const offs = [
      context.data.on("message.part.updated", schedule),
      context.data.on("message.updated", schedule),
    ];
    const timer = setInterval(sweep, SWEEP_MS);
    schedule();

    // `keymap.layer` reads Solid context, so it must run while a component is
    // rendering, not directly during setup. A null component mounted in the
    // `app` slot owns the layer for the plugin's lifetime.
    function FoldCommands() {
      context.keymap.layer(() => ({
        mode: "global",
        priority: 100,
        commands: [
          {
            id: "opencode-fold-diffs.toggle",
            title: "Fold / unfold file diffs",
            group: "Plugin",
            palette: true,
            bind: opts.key || false,
            run() {
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
              const box = transcript();
              const blocks = box ? scan(box, [], shell) : [];
              const folded = blocks.filter((block) => known.get(block)?.folded).length;
              context.ui.toast.show({
                title: "opencode-fold-diffs",
                variant: box ? "info" : "warning",
                duration: 4000,
                message: box
                  ? `transcript: yes · blocks: ${blocks.length} · folded: ${folded} · stats: ${titles ? "on" : "off"}`
                  : "transcript: not found — open a session first",
              });
            },
          },
        ],
        bindings: opts.key ? ["opencode-fold-diffs.toggle"] : [],
      }));
      return null;
    }
    const stopCommands = context.ui.slot({ append: "app", render: () => FoldCommands() });

    return () => {
      stopCommands();
      clearInterval(timer);
      if (pending) clearTimeout(pending);
      for (const off of offs) if (typeof off === "function") off();
    };
  },
};
