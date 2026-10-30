// Exercises the plugin against a mock renderer tree shaped like the real V2
// one: a sticky scrollbox holding BlockTool boxes. A V2 block header is a row
// box whose first two children are the label text ("# Wrote") and the path
// value, followed by the body children the host builds for edit / write /
// apply_patch.
//
//   node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import plugin from "../tui.js";
import server from "../index.js";
import { OPTIONS_RPC } from "../rpc.js";

class Box {
  constructor(kids = [], props = {}) {
    this.kids = kids;
    this.visible = true;
    Object.assign(this, props);
    // The real renderables expose setter-only props in older OpenTUI builds
    // and style getters in 0.8. Keep the original style separate from the
    // plain writable props so the plugin's restore path can be exercised.
    this._maxHeight = props.maxHeight;
    this._gap = props.gap;
    this._paddingTop = props.paddingTop;
    this._paddingBottom = props.paddingBottom;
    for (const kid of kids) kid.parent = this;
  }
  getChildren() {
    return this.kids;
  }
  getMaxHeight() {
    return this._maxHeight;
  }
  getGap() {
    return this._gap;
  }
  getPadding(edge) {
    if (edge === 1) return this._paddingTop;
    if (edge === 3) return this._paddingBottom;
    return undefined;
  }
}

// Text renderables expose plainText for reading and content for writing, which
// is the pair the plugin uses to restate a folded header's label.
class Text {
  constructor(text, props = {}) {
    this._text = text;
    this.visible = true;
    this._maxHeight = props.maxHeight;
    this._frozen = props.frozen === true;
    Object.assign(this, props);
  }
  get plainText() {
    return this._text;
  }
  set content(value) {
    if (this._frozen) return;
    this._text = value;
  }
  getMaxHeight() {
    return this._maxHeight;
  }
  getChildren() {
    return [];
  }
}

class Diff extends Box {
  constructor(diff) {
    super([]);
    this.diff = diff;
    this.filetype = "ts";
  }
}

// A written file's body. OpenCode renders it as a code renderable with a string
// `content` and a line map. `filetype` is deliberately omitted: it was dropped
// in 2.0.16 and restored in 2.0.27, so a plugin must not require it.
class Code extends Box {
  constructor(content) {
    super([]);
    this.content = content;
  }
  getLineSources() {
    return [];
  }
}

// MarkdownRenderable also has a string `content` in OpenTUI 0.8. It is not a
// written-file body and must not be counted or folded as one.
class Markdown extends Box {
  constructor(content) {
    super([]);
    this.content = content;
  }
}

class Scrollbox extends Box {
  constructor(kids, props = {}) {
    super(kids);
    this.stickyScroll = true;
    this.stickyStart = "bottom";
    this.scrollHeight = 100;
    Object.assign(this, props);
  }
  scrollTo() {}
}

const DIFF = [
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  " keep",
  "-gone",
  "-also gone",
  "+one",
  "+two",
  "+three",
  "+four",
].join("\n");

// The V2 header: a row box of [label, path]. The plugin reads the label and
// never touches the path value.
function header(label, value) {
  return new Box([new Text(label), new Text(value)]);
}

// header + <box><diff/></box> + optional diagnostics, the shape BlockTool
// renders for an edit.
function editBlock(label = "← Edit", value = "src/app.ts", diff = DIFF, extra = []) {
  const row = header(label, value);
  const body = new Box([new Diff(diff)]);
  return { block: new Box([row, body, ...extra]), row, body };
}

function writeBlock(lines = 40) {
  const body = new Box([new Code(Array.from({ length: lines }, (_, i) => `line ${i}`).join("\n"))]);
  const row = header("# Wrote", "src/new.ts");
  return { block: new Box([row, body]), row, body };
}

async function harness(
  t,
  kids,
  options,
  version = "2.0.24",
  root = new Box([new Scrollbox(kids)]),
  extra = {},
) {
  const listeners = {};
  const toasts = [];
  let slot;
  let layer;
  const context = {
    app: { version },
    options: options ?? {},
    renderer: { root, getSelection: () => undefined },
    data: {
      on(name, handler) {
        listeners[name] = handler;
        return () => delete listeners[name];
      },
    },
    keymap: {
      layer(callback) {
        layer = callback();
      },
    },
    ui: {
      router: { current: () => ({ type: "session", sessionID: "s" }) },
      toast: { show: (input) => toasts.push(input) },
      // On pre-2.0.23 builds the host mounts the plugin's slot, and rendering
      // it is what registers the keymap layer; 2.0.23+ registers in setup.
      slot(claim) {
        slot = claim;
        return () => {};
      },
    },
    ...extra,
  };
  const cleanup = await plugin.setup(context);
  if (typeof cleanup === "function") t.after(cleanup);
  // Render the fallback component, if this version uses one, so the layer is
  // registered either way before the test runs.
  const mount = () => slot?.render();
  mount();
  return {
    context,
    toasts,
    events: () => Object.keys(listeners),
    slot: () => slot,
    mount,
    fire: (name) => listeners[name]?.(),
    run: () => layer.commands[0].run(),
    command: () => layer.commands[0],
    commands: () => layer.commands,
    cleanup: async () => {
      if (typeof cleanup === "function") await cleanup();
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

test("folds an edit block to its header and counts the diff", async (t) => {
  const { block, row, body } = editBlock();
  const h = await harness(t, [block]);
  await settle();

  assert.equal(body.visible, false);
  assert.equal(body.overflow, "hidden");
  assert.equal(block.gap, 0);
  assert.equal(block.paddingTop, 0);
  assert.equal(row.kids[0].plainText, "← Edit +4 −2 · click to expand");
  // The path value is a separate node and stays untouched.
  assert.equal(row.kids[1].plainText, "src/app.ts");
});

test("counts written files in lines", async (t) => {
  const { block, row, body } = writeBlock();
  const h = await harness(t, [block]);
  await settle();

  assert.equal(body.visible, false);
  assert.equal(row.kids[0].plainText, "# Wrote 40 lines · click to expand");
});

test("does not count a trailing newline as an extra line", async (t) => {
  const content = Array.from({ length: 6 }, (_, i) => `line ${i}`).join("\n") + "\n";
  const row = header("# Wrote", "src/new.ts");
  const body = new Box([new Code(content)]);
  const block = new Box([row, body]);
  const h = await harness(t, [block]);
  await settle();

  assert.equal(body.visible, false);
  assert.equal(row.kids[0].plainText, "# Wrote 6 lines · click to expand");
});

test("counts a lone newline as one line", async (t) => {
  const row = header("# Wrote", "src/new.ts");
  const body = new Box([new Code("\n")]);
  const block = new Box([row, body]);
  const h = await harness(t, [block], { min_lines: 0 });
  await settle();

  assert.equal(body.visible, false);
  assert.equal(row.kids[0].plainText, "# Wrote 1 line · click to expand");
});

test("does not mistake diff content starting with --- or +++ for file headers", async (t) => {
  const diff = [
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "---not a header",
    "+++not a header",
    "--- looks like removed content",
    "+one",
    "+++ looks like added content",
    "+two",
    "+three",
    "+four",
  ].join("\n");
  const { block, row, body } = editBlock("← Edit", "src/app.ts", diff);
  const h = await harness(t, [block]);
  await settle();

  assert.equal(body.visible, false);
  assert.equal(row.kids[0].plainText, "← Edit +6 −2 · click to expand");
});

test("cleanup restores the blocks it folded", async (t) => {
  const { block, body } = editBlock();
  const h = await harness(t, [block]);
  await settle();
  assert.equal(body.visible, false);

  await h.cleanup();
  assert.equal(body.visible, true, "disabling the plugin must not leave a block folded");
  assert.equal(block.gap, 1);
  assert.equal(block.paddingTop, 1);
});

test("click toggles one block, restoring the host's chrome", async (t) => {
  const { block, row, body } = editBlock();
  const h = await harness(t, [block]);
  await settle();

  block.onMouseUp();
  assert.equal(body.visible, true);
  assert.equal(block.gap, 1);
  assert.equal(block.paddingTop, 1);
  assert.equal(row.kids[0].plainText, "← Edit");

  block.onMouseUp();
  assert.equal(body.visible, false);
});

test("a drag that ends on the block is a selection, not a click", async (t) => {
  const { block, body } = editBlock();
  const h = await harness(t, [block]);
  h.context.renderer.getSelection = () => ({ getSelectedText: () => "gone" });
  await settle();

  block.onMouseUp();
  assert.equal(body.visible, false);
});

test("a childless placeholder before the header does not hide the block", async (t) => {
  const { block, body } = editBlock();
  block.kids.unshift(new Box([]));
  const h = await harness(t, [block]);
  await settle();

  assert.equal(body.visible, false);
});

test("a placeholder inside the header row does not hide the label", async (t) => {
  const row = new Box([new Box([]), new Text("← Edit"), new Text("src/app.ts")]);
  const body = new Box([new Diff(DIFF)]);
  const block = new Box([row, body]);
  const h = await harness(t, [block]);
  await settle();

  assert.equal(body.visible, false);
  assert.equal(row.kids[1].plainText, "← Edit +4 −2 · click to expand");
});

test("small blocks and other tools are left alone", async (t) => {
  const small = editBlock(
    "← Edit",
    "tiny.ts",
    ["--- a/tiny.ts", "+++ b/tiny.ts", "-a", "+b"].join("\n"),
  );
  const bash = editBlock("# bash", "npm test");
  const h = await harness(t, [small.block, bash.block]);
  await settle();

  assert.equal(small.body.visible, true);
  assert.equal(bash.body.visible, true);
  assert.equal(bash.block.kids[0].kids[0].plainText, "# bash");
});

test("diagnostics stay visible while the diff folds", async (t) => {
  const diagnostics = new Box([new Text("ERROR [3:12] unused variable")]);
  const { block, body } = editBlock("← Edit", "src/app.ts", DIFF, [diagnostics]);
  const h = await harness(t, [block]);
  await settle();

  assert.equal(body.visible, false);
  assert.equal(diagnostics.visible, true);
});

test("blocks arriving later fold on a supported tool event", async (t) => {
  const first = editBlock();
  const kids = [first.block];
  const h = await harness(t, kids);
  await settle();

  const later = editBlock("← Patched", "src/other.ts");
  kids.push(later.block);
  h.fire("session.tool.success");
  await settle();
  assert.equal(later.body.visible, false);
});

test("the toggle unfolds everything, then folds what arrives next", async (t) => {
  const one = editBlock();
  const two = writeBlock();
  const kids = [one.block, two.block];
  const h = await harness(t, kids);
  await settle();

  h.run();
  assert.equal(one.body.visible, true);
  assert.equal(two.body.visible, true);
  assert.match(h.toasts.at(-1).message, /Unfolded 2 blocks/);

  const later = editBlock("# Created", "src/third.ts");
  kids.push(later.block);
  h.fire("session.tool.success");
  await settle();
  assert.equal(later.body.visible, true, "new blocks follow the toggled mode");

  h.run();
  assert.equal(later.body.visible, false);
});

test("lines: n leaves a peek and keeps the block's padding", async (t) => {
  const { block, body } = editBlock();
  const h = await harness(t, [block], { lines: 3 });
  await settle();

  assert.equal(body.visible, true);
  assert.equal(body.maxHeight, 3);
  assert.equal(block.gap, undefined, "chrome is only tightened for a title-only fold");
});

test("folded: false only installs the toggle", async (t) => {
  const { block, body } = editBlock();
  const h = await harness(t, [block], { folded: false });
  await settle();

  assert.equal(body.visible, true);
  h.run();
  assert.equal(body.visible, false);
});

test("stats: false leaves the header alone", async (t) => {
  const { block, row, body } = editBlock();
  const h = await harness(t, [block], { stats: false });
  await settle();

  assert.equal(body.visible, false);
  assert.equal(row.kids[0].plainText, "← Edit");
});

test("re-adopting a header that already carries the suffix does not double it", async (t) => {
  const { block, row, body } = editBlock("← Edit +4 −2 · click to expand", "src/app.ts");
  const h = await harness(t, [block]);
  await settle();

  assert.equal(body.visible, false);
  assert.equal(row.kids[0].plainText, "← Edit +4 −2 · click to expand");
});

test("binds nothing by default and only what it is asked to", async (t) => {
  const a = await harness(t, []);
  assert.equal(a.command().bind, false, "ctrl+o is left to open.menu");

  const b = await harness(t, [], { key: "ctrl+shift+d" });
  assert.equal(b.command().bind, "ctrl+shift+d");
});

test("registers the command layer from setup on 2.0.23+", async (t) => {
  const h = await harness(t, []);
  assert.equal(h.slot(), undefined, "no app slot is needed");
  assert.equal(h.command().id, "opencode-fold-diffs.toggle");
  assert.equal(h.command().palette, true);
});

test("falls back to the app slot before 2.0.23", async (t) => {
  const h = await harness(t, [], {}, "2.0.22");
  assert.equal(h.slot().append, "app", "the layer is registered from a mounted component");
  assert.equal(h.command().id, "opencode-fold-diffs.toggle");
  assert.equal(h.command().palette, true);
});

test("treats an unparseable version as an older build", async (t) => {
  const h = await harness(t, [], {}, null);
  assert.equal(h.slot().append, "app");
});

test("listens for V2 transcript events, not the V1 names", async (t) => {
  const h = await harness(t, []);
  const events = h.events();
  // These are the events the V2 client emits. The V1 names they replace exist
  // only as legacy schemas and never fire, so subscribing to them folded
  // nothing until the sweep timer ran. session.message.content.updated is not
  // part of the public TUI event union in 2.2.3 and is deliberately absent.
  for (const name of [
    "session.tool.called",
    "session.tool.progress",
    "session.tool.success",
    "session.tool.failed",
    "session.step.ended",
    "session.execution.succeeded",
  ])
    assert.ok(events.includes(name), `listens for ${name}`);
  assert.equal(events.includes("session.message.content.updated"), false);
  assert.equal(events.includes("session.shell.ended"), false, "bash folding is off");
  assert.equal(events.includes("message.part.updated"), false, "no V1 event names");
  assert.equal(events.includes("message.updated"), false, "no V1 event names");
});

test("listens for the shell event only when bash folding is on", async (t) => {
  const off = await harness(t, []);
  assert.equal(off.events().includes("session.shell.ended"), false);

  const on = await harness(t, [], { bash: true });
  assert.ok(on.events().includes("session.shell.ended"));
});

test("diagnose reports what the plugin can see", async (t) => {
  const { block } = editBlock();
  // dump: false so the test never clobbers a live transcript dump.
  const h = await harness(t, [block], { dump: false });
  await settle();

  const diagnose = h.commands().find((c) => c.id === "opencode-fold-diffs.diagnose");
  diagnose.run();
  assert.match(h.toasts.at(-1).message, /transcript: yes · blocks: 1 · folded: 1 · stats: on/);
  assert.match(h.toasts.at(-1).message, /options: /);
});

test("ships a server entry so the plugin is discovered by id", async () => {
  const entry = await import("../index.js");
  assert.equal(entry.default.id, "opencode-fold-diffs");
  assert.equal(typeof entry.default.setup, "function");
});

test("server publishes its opencode.json options over RPC", async (t) => {
  let registered;
  let disposed = false;
  const cleanup = await server.setup({
    options: { lines: 4, stats: false },
    rpc: {
      async register(definition, handlers) {
        registered = { definition, handlers };
        return {
          dispose() {
            disposed = true;
          },
        };
      },
    },
  });
  t.after(() => cleanup?.());

  assert.equal(registered.definition.id, OPTIONS_RPC.id);
  const result = registered.handlers.get({});
  // The host's portable RPC awaits every handler result. A plain object fails
  // at runtime with "t(...).then is not a function", so the handler must be async.
  assert.equal(typeof result.then, "function");
  assert.deepEqual(await result, {
    options: { lines: 4, stats: false },
  });
  await cleanup();
  assert.equal(disposed, true);
});

test("server setup survives a host without portable RPC", async () => {
  const cleanup = await server.setup({ options: { lines: 1 } });
  assert.equal(typeof cleanup, "function");
  await cleanup();
});

test("merges server options with cli.json taking precedence", async (t) => {
  const registry = new Map();
  const stop = await server.setup({
    options: { lines: 7, stats: false, key: "ctrl+shift+x", bash: true },
    rpc: {
      async register(definition, handlers) {
        registry.set(definition.id, handlers);
        return { dispose: () => registry.delete(definition.id) };
      },
    },
  });
  t.after(() => stop?.());

  const client = {
    rpc(definition) {
      const handlers = registry.get(definition.id);
      return { get: (input) => handlers.get(input) };
    },
  };
  const { block, row, body } = editBlock();
  const h = await harness(t, [block], { lines: 2 }, "2.0.24", undefined, { client });
  await settle();

  assert.equal(body.maxHeight, 2, "cli.json lines wins over the server value");
  assert.equal(row.kids[0].plainText, "← Edit", "server stats: false is still applied");
  assert.equal(h.command().bind, "ctrl+shift+x", "server key is applied");
  assert.ok(h.events().includes("session.shell.ended"), "server bash: true is applied");
});

test("falls back to cli.json options when the server bridge is unavailable", async (t) => {
  const { block, body } = editBlock();
  const h = await harness(t, [block], { lines: 3 }, "2.0.24", undefined, {
    client: { rpc: () => ({ get: async () => Promise.reject(new Error("rpc.unavailable")) }) },
  });
  await settle();

  assert.equal(body.visible, true);
  assert.equal(body.maxHeight, 3);
});

test("folds nothing outside a session route", async (t) => {
  const { block, body } = editBlock();
  const h = await harness(t, [block]);
  h.context.ui.router.current = () => ({ type: "home" });
  await settle();

  assert.equal(body.visible, true);
});

// V2 added a second sticky scrollbox: the shell output viewer dialog. It must
// never be mistaken for the transcript, or a scan that hits it first would
// latch onto the wrong tree and fold nothing.
test("never mistakes the shell output viewer for the transcript", async (t) => {
  const { block, body } = editBlock();
  const viewer = new Scrollbox([]);
  viewer.id = "shell-output-scroll";
  const transcript = new Scrollbox([block]);
  const h = await harness(t, [], {}, "2.0.24", new Box([viewer, transcript]));
  await settle();

  assert.equal(body.visible, false, "the real transcript still folds");
});

// A scrolled-up transcript can report stickyScroll=false, but it still has the
// bottom sticky start and session-part descendants. The old matcher rejected it
// and folded nothing until the user scrolled back to the bottom.
test("finds a scrolled-up transcript by its bottom anchor and session parts", async (t) => {
  const { block, body } = editBlock();
  block.id = "session-part:msg_1:part_1";
  const scroll = new Scrollbox([block], { stickyScroll: false });
  const h = await harness(t, [], {}, "2.0.24", new Box([scroll]));
  await settle();

  assert.equal(body.visible, false);
});

test("a non-sticky scrollbox without session evidence is not the transcript", async (t) => {
  const { block, body } = editBlock();
  const scroll = new Scrollbox([block], { stickyScroll: false });
  const h = await harness(t, [], {}, "2.0.24", new Box([scroll]));
  await settle();

  assert.equal(body.visible, true);
});

// Taking the first sticky scrollbox is not safe: an empty panel can precede the
// transcript and then get cached forever. Candidates are scored, and a
// session-part descendant outweighs a larger unrelated scrollHeight.
test("does not latch onto the first sticky scrollbox", async (t) => {
  const decoy = new Scrollbox([], { scrollHeight: 5000 });
  const { block, body } = editBlock();
  block.id = "session-part:msg_1:part_1";
  const real = new Scrollbox([block], { scrollHeight: 20 });
  const h = await harness(t, [], {}, "2.0.24", new Box([decoy, real]));
  await settle();

  assert.equal(body.visible, false);
});

test("drops the cached transcript when the session route changes", async (t) => {
  const first = editBlock();
  first.block.id = "session-part:msg_a:part_a";
  const second = editBlock();
  const one = new Scrollbox([first.block], { scrollHeight: 200 });
  const two = new Scrollbox([second.block], { scrollHeight: 100 });
  const root = new Box([one, two]);
  const h = await harness(t, [], {}, "2.0.24", root);
  await settle();
  assert.equal(first.body.visible, false);
  assert.equal(second.body.visible, true);

  // The new session's transcript is the second box now. Without invalidating
  // the cached transcript on the route change the plugin keeps folding the old
  // one, which is still attached to the renderer.
  first.block.id = "";
  second.block.id = "session-part:msg_b:part_b";
  h.context.ui.router.current = () => ({ type: "session", sessionID: "s2" });
  h.fire("session.tool.success");
  await settle();

  assert.equal(second.body.visible, false);
});

test("re-finds the transcript when the cached one is detached", async (t) => {
  const first = editBlock();
  const second = editBlock();
  const one = new Scrollbox([first.block]);
  const two = new Scrollbox([second.block]);
  const root = new Box([one, two]);
  const h = await harness(t, [], {}, "2.0.24", root);
  await settle();
  assert.equal(first.body.visible, false);

  root.kids = [two];
  one.parent = undefined;
  h.fire("session.tool.success");
  await settle();
  assert.equal(second.body.visible, false, "the detached transcript is not reused");
});

// Expanded state belongs to the part, not to one renderable instance. A
// remount (hot reload, list virtualization) used to forget that a block had
// been unfolded and immediately fold it again with the global mode.
test("remembers an unfolded part when its block is remounted", async (t) => {
  const first = editBlock();
  first.block.id = "session-part:msg_1:part_1";
  const kids = [first.block];
  const h = await harness(t, kids);
  await settle();

  first.block.onMouseUp();
  assert.equal(first.body.visible, true);

  const second = editBlock();
  second.block.id = "session-part:msg_1:part_1";
  kids[0] = second.block;
  h.fire("session.tool.success");
  await settle();

  assert.equal(second.body.visible, true, "the part stays unfolded after remount");
});

test("clears per-session fold state when the session changes", async (t) => {
  const first = editBlock();
  first.block.id = "session-part:msg_1:part_1";
  const kids = [first.block];
  const h = await harness(t, kids);
  await settle();
  first.block.onMouseUp();
  assert.equal(first.body.visible, true);

  h.context.ui.router.current = () => ({ type: "session", sessionID: "s2" });
  const second = editBlock();
  second.block.id = "session-part:msg_1:part_1";
  kids[0] = second.block;
  h.fire("session.tool.success");
  await settle();

  assert.equal(second.body.visible, false, "the new session starts folded again");
});

test("refreshes a folded header when the block's content changes", async (t) => {
  const { block, row, body } = writeBlock(40);
  const h = await harness(t, [block]);
  await settle();
  assert.equal(row.kids[0].plainText, "# Wrote 40 lines · click to expand");

  body.kids[0].content = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n");
  h.fire("session.tool.progress");
  await settle();

  assert.equal(row.kids[0].plainText, "# Wrote 80 lines · click to expand");
});

test("restores the host's actual chrome and maxHeight", async (t) => {
  const row = header("← Edit", "src/app.ts");
  const body = new Box([new Diff(DIFF)], { maxHeight: 7 });
  const block = new Box([row, body], { gap: 3, paddingTop: 2, paddingBottom: 4 });
  const h = await harness(t, [block]);
  await settle();

  assert.equal(block.gap, 0);
  assert.equal(block.paddingTop, 0);
  assert.equal(body.visible, false);

  block.onMouseUp();
  assert.equal(block.gap, 3, "the real gap is restored, not a hardcoded 1");
  assert.equal(block.paddingTop, 2);
  assert.equal(block.paddingBottom, 4);
  assert.equal(body.maxHeight, 7, "the host's maxHeight is restored");
});

test("does not treat a MarkdownRenderable's string content as a written file", async (t) => {
  const row = header("# Wrote", "README.md");
  const body = new Box([new Markdown("# hello\n\nbody")]);
  const block = new Box([row, body]);
  const h = await harness(t, [block]);
  await settle();

  assert.equal(body.visible, true);
});

test("cleanup removes the diff click handler and a late click cannot re-fold", async (t) => {
  const { block, body } = editBlock();
  const h = await harness(t, [block]);
  await settle();

  const handler = block.onMouseUp;
  assert.equal(typeof handler, "function");
  await h.cleanup();

  assert.equal(block.onMouseUp, undefined, "the plugin's handler is cleared");
  handler();
  assert.equal(body.visible, true, "a late click after disposal is ignored");
});

test("cleanup restores a suffix even after header rewriting was disabled", async (t) => {
  const one = editBlock();
  const two = editBlock("← Edit", "src/two.ts");
  // Solid owns this label: writes are accepted but never change plainText, so
  // the plugin turns its global header-rewrite flag off after this block.
  two.row.kids[0]._frozen = true;

  const h = await harness(t, [one.block, two.block]);
  await settle();
  assert.match(one.row.kids[0].plainText, /click to expand$/);
  assert.equal(two.row.kids[0].plainText, "← Edit");

  await h.cleanup();
  assert.equal(one.row.kids[0].plainText, "← Edit", "the earlier suffix is still removed");
});

test("ignores non-finite numeric options and a non-string key", async (t) => {
  const { block, body } = editBlock();
  const h = await harness(t, [block], {
    lines: Infinity,
    min_lines: 1e999,
    key: 42,
  });
  await settle();

  assert.equal(body.visible, false, "non-finite min_lines falls back to the default");
  assert.equal(body.maxHeight, undefined);
  assert.equal(h.command().bind, false, "a non-string key is not a binding");
});

test("truncates fractional and clamps negative line counts", async (t) => {
  const { block, body } = editBlock();
  const h = await harness(t, [block], { lines: 3.9, min_lines: -1 });
  await settle();

  assert.equal(body.maxHeight, 3);
});

// --- bash commands -------------------------------------------------------
//
// The host already collapses a long command to two lines and its output to ten,
// both with click-to-expand, so folding commands is opt-in on V2. The block is
// a box wrapping the "$ command" text, the output, and the host's own expand
// hint. It carries no header of its own.
function shellBlock({
  lines = 20,
  command,
  output = "ok",
  hint = true,
  running = false,
  title,
  width,
  height,
  maxHeight,
} = {}) {
  const body = command ?? Array.from({ length: lines }, (_, i) => `print(${i})`).join("\n");
  const first = running
    ? new Box([new Text(body)])
    : new Text("$ " + body, { width, height, maxHeight });
  const inner = [first];
  if (output) inner.push(new Text(output));
  if (hint) inner.push(new Text("Click to expand"));
  const wrap = new Box(inner, { gap: 1 });
  // BlockTool renders the path/title Show first; with neither set it leaves a
  // childless placeholder, so the wrapper is not necessarily the first child.
  const block = new Box(title ? [new Text(title), wrap] : [new Box([]), wrap]);
  return { block, cmd: first, wrap };
}

const click = () => {
  const event = {
    stopped: 0,
    stopPropagation() {
      this.stopped++;
    },
  };
  return event;
};

test("leaves bash commands to the host by default", async (t) => {
  const { block, cmd } = shellBlock();
  const h = await harness(t, [block]);
  await settle();

  assert.equal(cmd.visible, true);
  assert.equal(cmd.onMouseUp, undefined);
});

test("folds a long bash command to its first row when enabled", async (t) => {
  const { block, cmd, wrap } = shellBlock();
  const h = await harness(t, [block], { bash: true });
  await settle();

  assert.equal(cmd.visible, true);
  assert.equal(cmd.maxHeight, 1);
  assert.equal(cmd.overflow, "hidden");
  // The output and the host's hint are siblings of the command, not children,
  // so folding the command leaves both on screen.
  assert.equal(wrap.kids[1].maxHeight, undefined);
  assert.equal(wrap.kids[2].maxHeight, undefined);
  // The block's own handler is the host's expand toggle and has no getter to
  // chain, so it must be left exactly as it was found.
  assert.equal(block.onMouseUp, undefined);
  // The chrome holds up the output, so it is not collapsed the way a diff's is.
  assert.equal(block.gap, undefined);
});

test("clicking the command toggles it and stops the host seeing the click", async (t) => {
  const { block, cmd } = shellBlock();
  const h = await harness(t, [block], { bash: true });
  await settle();

  const open = click();
  cmd.onMouseUp(open);
  assert.equal(cmd.visible, true);
  assert.equal(open.stopped, 1);

  const shut = click();
  cmd.onMouseUp(shut);
  assert.equal(cmd.visible, true);
  assert.equal(cmd.maxHeight, 1);
  assert.equal(shut.stopped, 1);
  assert.equal(block.onMouseUp, undefined);
});

test("a drag ending on the command is a selection, not a click", async (t) => {
  const { block, cmd } = shellBlock();
  const h = await harness(t, [block], { bash: true });
  h.context.renderer.getSelection = () => ({ getSelectedText: () => "print(3)" });
  await settle();

  cmd.onMouseUp(click());
  assert.equal(cmd.visible, true);
  assert.equal(cmd.maxHeight, 1);
});

test("short and still-running commands are left alone", async (t) => {
  const short = shellBlock({ lines: 3 });
  const running = shellBlock({ running: true });
  const h = await harness(t, [short.block, running.block], { bash: true });
  await settle();

  assert.equal(short.cmd.visible, true);
  assert.equal(running.cmd.visible, true);
  assert.equal(running.cmd.onMouseUp, undefined);
});

test("does not fold a running command's output that begins with $", async (t) => {
  const output = Array.from({ length: 10 }, (_, i) => `$ output ${i}`).join("\n");
  const { block, wrap } = shellBlock({ running: true, output });
  const outputNode = wrap.kids[1];
  const h = await harness(t, [block], { bash: true });
  await settle();

  assert.equal(outputNode.visible, true);
  assert.equal(outputNode.maxHeight, undefined);
  assert.equal(outputNode.onMouseUp, undefined);
});

test("folds a wrapped single-line command using its intrinsic rows", async (t) => {
  const { block, cmd } = shellBlock({
    command: "echo " + "x".repeat(240),
    width: 40,
    height: 2, // the host clamps this to two rows
  });
  const h = await harness(t, [block], { bash: true });
  await settle();

  assert.equal(cmd.maxHeight, 1);
});

test("bash_lines sets how much of the command survives", async (t) => {
  const { block, cmd } = shellBlock();
  const h = await harness(t, [block], { bash: true, bash_lines: 3 });
  await settle();

  assert.equal(cmd.visible, true);
  assert.equal(cmd.maxHeight, 3);
});

test("bash cleanup restores the host's two-row clamp and clears the handler", async (t) => {
  const { block, cmd } = shellBlock({ maxHeight: 2 });
  const h = await harness(t, [block], { bash: true });
  await settle();
  assert.equal(cmd.maxHeight, 1);

  const handler = cmd.onMouseUp;
  await h.cleanup();

  assert.equal(cmd.maxHeight, 2, "the host's clamp is restored, not undefined");
  assert.equal(cmd.onMouseUp, undefined);
  handler(click());
  assert.equal(cmd.maxHeight, 2, "a late click cannot re-fold the command");
});

test("ctrl+o folds and unfolds commands alongside diffs", async (t) => {
  const edit = editBlock();
  const shell = shellBlock();
  const h = await harness(t, [edit.block, shell.block], { bash: true });
  await settle();

  h.run();
  assert.equal(edit.body.visible, true);
  assert.equal(shell.cmd.visible, true);
  assert.match(h.toasts.at(-1).message, /Unfolded 2 blocks/);

  h.run();
  assert.equal(edit.body.visible, false);
  assert.equal(shell.cmd.maxHeight, 1);
});

test("package declares no non-standard opencode engine", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.engines?.opencode, undefined);
});
