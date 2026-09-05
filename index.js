// Fold write / edit / apply_patch blocks in the opencode transcript.
//
// opencode already collapses bash output to 10 lines and generic tool output to
// 3, both with click-to-expand. The three tools that produce the most
// scrollback -- write, edit and apply_patch -- are the ones it does not touch:
// they render the whole diff, or the whole written file, forever. The three
// upstream requests for a setting (#9089 minimal diff display, #14511 a toggle
// keybind, #19074 collapse tool output) were all closed without one, so this
// does it from a plugin.
//
// A folded block renders as its title line -- "← Edit src/app.ts +12 −3" --
// and opens on click, or with ctrl+o for every block at once.
//
// Options (tui.json -> ["opencode-fold-diffs", { ... }]):
//   lines      lines of the body left visible when folded  (default 0, title only)
//   min_lines  leave blocks with fewer content lines alone  (default 6)
//   stats      append "+12 −3 · click to expand" to the title (default true)
//   folded     new blocks start folded                      (default true)
//   key        binding that folds/unfolds every block        (default "ctrl+o")

const DEFAULTS = {
  lines: 0,
  min_lines: 6,
  stats: true,
  folded: true,
  key: "ctrl+o",
}

// BlockTool titles of the file-writing tools, as rendered in the transcript.
// Matching the title is what keeps this off every other block tool: bash,
// todowrite, questions and the generic fallback all collapse themselves
// already, and folding them again would fight the host.
const TITLES = [/^← Edit /, /^# Wrote /, /^← Patched /, /^# Created /, /^# Deleted /, /^# Moved /]

// How often to re-scan when nothing is streaming. Events cover the live case;
// this catches a session opened from history, whose parts arrive as one batch
// before any event this plugin sees.
const SWEEP_MS = 2000

function children(node) {
  return typeof node?.getChildren === "function" ? node.getChildren() : []
}

function plain(node) {
  const value = node?.plainText
  return typeof value === "string" ? value : undefined
}

// Duck-typing, not instanceof: the classes live in the host's bundled
// @opentui/core and are minified, so their names are not stable. A diff
// renderable is the only thing in the tree carrying a `diff` string, and a code
// renderable the only thing pairing `content` with `filetype`.
function isDiff(node) {
  return typeof node?.diff === "string"
}

function isCode(node) {
  return typeof node?.content === "string" && typeof node?.filetype === "string"
}

function bulk(node, found = []) {
  if (!node || node.isDestroyed) return found
  if (isDiff(node) || isCode(node)) {
    found.push(node)
    return found
  }
  for (const child of children(node)) bulk(child, found)
  return found
}

// The transcript is the only scrollbox in the TUI that asks to stick to the
// bottom (same discriminator opencode-snap-to-bottom uses). Staying inside it
// is what keeps the permission dialog's diff preview untouched -- you should
// always see in full what you are about to approve.
function isTranscript(node) {
  return (
    typeof node?.scrollTo === "function" &&
    typeof node?.scrollHeight === "number" &&
    node.stickyScroll === true &&
    node.stickyStart === "bottom"
  )
}

function findTranscript(node) {
  if (!node || node.isDestroyed) return
  if (isTranscript(node)) return node
  if (typeof node.scrollTo === "function") return
  for (const child of children(node)) {
    const hit = findTranscript(child)
    if (hit) return hit
  }
}

// A BlockTool renders the title text first, then its body. Read the title off
// the first child; anything else is not one of ours.
function blockTitle(node) {
  const kids = children(node)
  // Title plus at least one body child. The guard also keeps the plain-text
  // read -- which rebuilds a string every call -- off the leaf nodes, and the
  // transcript is mostly leaf nodes.
  if (kids.length < 2) return
  const head = plain(kids[0])
  if (!head) return
  return TITLES.some((re) => re.test(head)) ? head : undefined
}

function scan(node, hits = []) {
  if (!node || node.isDestroyed) return hits
  // A matched block never contains another one, so stop descending.
  if (blockTitle(node)) {
    hits.push(node)
    return hits
  }
  for (const child of children(node)) scan(child, hits)
  return hits
}

// "+12 −3" from a unified diff, "42 lines" from a written file. Counted off the
// renderable's own props, so it stays right even for parts the TUI store has
// already dropped.
function summarise(nodes) {
  let added = 0
  let removed = 0
  let lines = 0
  let diffs = 0
  for (const node of nodes) {
    if (isDiff(node)) {
      diffs++
      for (const line of node.diff.split("\n")) {
        if (line.startsWith("+++") || line.startsWith("---")) continue
        if (line.startsWith("+")) added++
        else if (line.startsWith("-")) removed++
      }
      continue
    }
    lines += node.content.split("\n").length
  }
  if (diffs) return { size: added + removed, label: `+${added} −${removed}` }
  return { size: lines, label: `${lines} ${lines === 1 ? "line" : "lines"}` }
}

export default {
  id: "opencode-fold-diffs",
  tui: async (api, options) => {
    const opts = { ...DEFAULTS, ...(options ?? {}) }
    const peek = Math.max(0, Number(opts.lines) || 0)
    const floor = Math.max(0, Number(opts.min_lines) || 0)

    // Folded blocks, by their block renderable. WeakMap so a session switch,
    // which destroys the renderables, drops the state with them.
    const known = new WeakMap()
    // The mode new blocks adopt. ctrl+o flips it, so "expand everything" also
    // means "and stop folding what arrives next", the way a verbose toggle works.
    let folding = opts.folded !== false
    // Set once the title rewrite is proven not to take, so we stop retrying it.
    let titles = opts.stats !== false

    let cached
    function transcript() {
      if (cached && !cached.isDestroyed) return cached
      cached = findTranscript(api.renderer.root)
      return cached
    }

    function apply(state, fold) {
      state.folded = fold
      state.body.forEach((node, index) => {
        try {
          // Yoga honours a 0 max-height, so the body disappears from layout
          // entirely rather than leaving a gap where it used to be.
          node.maxHeight = fold ? (index === 0 ? peek : 0) : undefined
          node.overflow = fold ? "hidden" : state.overflow[index]
        } catch {}
      })
      // With the body at zero height, the block's own padding and the gap it
      // keeps between children are all that is left: four near-blank rows
      // around one line of title. Collapse the chrome too so a folded block
      // reads as the single row it now is. The restored values are BlockTool's
      // own (paddingTop/Bottom 1, gap 1) because opentui gives these setters no
      // getters to read the originals back from.
      if (peek === 0) {
        try {
          state.block.gap = fold ? 0 : 1
          state.block.paddingTop = fold ? 0 : 1
          state.block.paddingBottom = fold ? 0 : 1
        } catch {}
      }
      if (!titles || !state.title) return
      const next = fold ? `${state.title.text} ${state.suffix}` : state.title.text
      try {
        state.title.node.content = next
      } catch {
        titles = false
        return
      }
      // The host owns that text node. If solid is not letting go of it there is
      // nothing to be gained by asking again on every block.
      if (plain(state.title.node) !== next) titles = false
    }

    function adopt(block) {
      const title = blockTitle(block)
      if (!title) return
      const kids = children(block)
      // Everything after the title that actually carries a diff or a file body.
      // Diagnostics and the error line carry neither, so an edit that broke the
      // build still says so while folded.
      const body = []
      const heavy = []
      for (const child of kids.slice(1)) {
        const found = bulk(child)
        if (!found.length) continue
        body.push(child)
        heavy.push(...found)
      }
      if (!body.length) return
      const stats = summarise(heavy)
      if (stats.size < floor) return

      const head = kids[0]
      const state = {
        block,
        body,
        overflow: body.map((node) => node.overflow),
        title: plain(head) === title ? { node: head, text: title } : undefined,
        suffix: `${stats.label} · click to expand`,
        folded: false,
      }
      known.set(block, state)

      block.onMouseUp = () => {
        // Copy-on-select is a drag ending on the block; that is not a click.
        if (api.renderer.getSelection?.()?.getSelectedText?.()) return
        apply(state, !state.folded)
      }

      if (folding) apply(state, true)
    }

    function sweep() {
      if (api.route.current.name !== "session") return
      const box = transcript()
      if (!box) return
      for (const block of scan(box)) {
        if (known.has(block)) continue
        adopt(block)
      }
    }

    function all(fold) {
      folding = fold
      const box = transcript()
      if (!box) return 0
      let count = 0
      for (const block of scan(box)) {
        const state = known.get(block)
        if (!state || state.folded === fold) continue
        apply(state, fold)
        count++
      }
      return count
    }

    let pending
    function schedule() {
      if (pending) return
      pending = setTimeout(() => {
        pending = undefined
        sweep()
      }, 120)
    }

    const offs = [
      api.event.on("message.part.updated", schedule),
      api.event.on("message.updated", schedule),
    ]
    const timer = setInterval(sweep, SWEEP_MS)
    schedule()

    api.keymap.registerLayer({
      mode: "base",
      priority: 100,
      commands: [
        {
          name: "fold_diffs.toggle",
          title: "Fold / unfold file diffs",
          category: "Plugin",
          run() {
            sweep()
            const fold = !folding
            const changed = all(fold)
            api.ui.toast({
              variant: "info",
              message: changed
                ? `${fold ? "Folded" : "Unfolded"} ${changed} ${changed === 1 ? "block" : "blocks"}`
                : `New file blocks will be ${fold ? "folded" : "unfolded"}`,
              duration: 2000,
            })
            return true
          },
        },
      ],
      bindings: opts.key
        ? [{ key: opts.key, cmd: "fold_diffs.toggle", desc: "Fold / unfold file diffs", preventDefault: true }]
        : [],
    })

    api.lifecycle.onDispose(() => {
      clearInterval(timer)
      if (pending) clearTimeout(pending)
      for (const off of offs) if (typeof off === "function") off()
    })
  },
}
