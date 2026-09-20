// Exercises the plugin against a mock renderer tree shaped like the real V2
// one: a sticky scrollbox holding BlockTool boxes. A V2 block header is a row
// box whose first two children are the label text ("# Wrote") and the path
// value, followed by the body children the host builds for edit / write /
// apply_patch.
//
//   node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import plugin from "../tui.js";

class Box {
  constructor(kids = [], props = {}) {
    this.kids = kids;
    this.visible = true;
    Object.assign(this, props);
  }
  getChildren() {
    return this.kids;
  }
}

// Text renderables expose plainText for reading and content for writing, which
// is the pair the plugin uses to restate a folded header's label.
class Text {
  constructor(text) {
    this._text = text;
    this.visible = true;
  }
  get plainText() {
    return this._text;
  }
  set content(value) {
    this._text = value;
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

class Code extends Box {
  constructor(content) {
    super([]);
    this.content = content;
    this.filetype = "ts";
  }
}

class Scrollbox extends Box {
  constructor(kids) {
    super(kids);
    this.stickyScroll = true;
    this.stickyStart = "bottom";
    this.scrollHeight = 100;
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

function harness(t, kids, options) {
  const root = new Box([new Scrollbox(kids)]);
  const listeners = {};
  const toasts = [];
  let slot;
  let layer;
  const context = {
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
      // The host mounts the plugin's slot; rendering it is what registers the
      // keymap layer, matching the real "keymap.layer needs Solid context"
      // contract.
      slot(claim) {
        slot = claim;
        return () => {};
      },
    },
  };
  const cleanup = plugin.setup(context);
  if (typeof cleanup === "function") t.after(cleanup);
  // Mount the slot before returning, and expose the claim so a test can check
  // the layer is not registered until it renders.
  const mount = () => slot?.render();
  mount();
  return {
    context,
    toasts,
    slot: () => slot,
    mount,
    fire: (name) => listeners[name]?.(),
    run: () => layer.commands[0].run(),
    command: () => layer.commands[0],
    commands: () => layer.commands,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

test("folds an edit block to its header and counts the diff", async (t) => {
  const { block, row, body } = editBlock();
  const h = harness(t, [block]);
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
  const h = harness(t, [block]);
  await settle();

  assert.equal(body.visible, false);
  assert.equal(row.kids[0].plainText, "# Wrote 40 lines · click to expand");
});

test("click toggles one block, restoring the host's chrome", async (t) => {
  const { block, row, body } = editBlock();
  const h = harness(t, [block]);
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
  const h = harness(t, [block]);
  h.context.renderer.getSelection = () => ({ getSelectedText: () => "gone" });
  await settle();

  block.onMouseUp();
  assert.equal(body.visible, false);
});

test("a childless placeholder before the header does not hide the block", async (t) => {
  const { block, body } = editBlock();
  block.kids.unshift(new Box([]));
  const h = harness(t, [block]);
  await settle();

  assert.equal(body.visible, false);
});

test("a placeholder inside the header row does not hide the label", async (t) => {
  const row = new Box([new Box([]), new Text("← Edit"), new Text("src/app.ts")]);
  const body = new Box([new Diff(DIFF)]);
  const block = new Box([row, body]);
  const h = harness(t, [block]);
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
  const h = harness(t, [small.block, bash.block]);
  await settle();

  assert.equal(small.body.visible, true);
  assert.equal(bash.body.visible, true);
  assert.equal(bash.block.kids[0].kids[0].plainText, "# bash");
});

test("diagnostics stay visible while the diff folds", async (t) => {
  const diagnostics = new Box([new Text("ERROR [3:12] unused variable")]);
  const { block, body } = editBlock("← Edit", "src/app.ts", DIFF, [diagnostics]);
  const h = harness(t, [block]);
  await settle();

  assert.equal(body.visible, false);
  assert.equal(diagnostics.visible, true);
});

test("blocks arriving later fold on the part event", async (t) => {
  const first = editBlock();
  const kids = [first.block];
  const h = harness(t, kids);
  await settle();

  const later = editBlock("← Patched", "src/other.ts");
  kids.push(later.block);
  h.fire("message.part.updated");
  await settle();
  assert.equal(later.body.visible, false);
});

test("the toggle unfolds everything, then folds what arrives next", async (t) => {
  const one = editBlock();
  const two = writeBlock();
  const kids = [one.block, two.block];
  const h = harness(t, kids);
  await settle();

  h.run();
  assert.equal(one.body.visible, true);
  assert.equal(two.body.visible, true);
  assert.match(h.toasts.at(-1).message, /Unfolded 2 blocks/);

  const later = editBlock("# Created", "src/third.ts");
  kids.push(later.block);
  h.fire("message.updated");
  await settle();
  assert.equal(later.body.visible, true, "new blocks follow the toggled mode");

  h.run();
  assert.equal(later.body.visible, false);
});

test("lines: n leaves a peek and keeps the block's padding", async (t) => {
  const { block, body } = editBlock();
  const h = harness(t, [block], { lines: 3 });
  await settle();

  assert.equal(body.visible, true);
  assert.equal(body.maxHeight, 3);
  assert.equal(block.gap, undefined, "chrome is only tightened for a title-only fold");
});

test("folded: false only installs the toggle", async (t) => {
  const { block, body } = editBlock();
  const h = harness(t, [block], { folded: false });
  await settle();

  assert.equal(body.visible, true);
  h.run();
  assert.equal(body.visible, false);
});

test("stats: false leaves the header alone", async (t) => {
  const { block, row, body } = editBlock();
  const h = harness(t, [block], { stats: false });
  await settle();

  assert.equal(body.visible, false);
  assert.equal(row.kids[0].plainText, "← Edit");
});

test("re-adopting a header that already carries the suffix does not double it", async (t) => {
  const { block, row, body } = editBlock("← Edit +4 −2 · click to expand", "src/app.ts");
  const h = harness(t, [block]);
  await settle();

  assert.equal(body.visible, false);
  assert.equal(row.kids[0].plainText, "← Edit +4 −2 · click to expand");
});

test("binds nothing by default and only what it is asked to", async (t) => {
  const a = harness(t, []);
  assert.equal(a.command().bind, false, "ctrl+o is left to open.menu");

  const b = harness(t, [], { key: "ctrl+shift+d" });
  assert.equal(b.command().bind, "ctrl+shift+d");
});

test("owns its command layer through the app slot", async (t) => {
  const h = harness(t, []);
  assert.equal(h.slot().append, "app", "the layer is registered from a mounted component");
  assert.equal(h.command().id, "opencode-fold-diffs.toggle");
  assert.equal(h.command().palette, true);
});

test("diagnose reports what the plugin can see", async (t) => {
  const { block } = editBlock();
  // dump: false so the test never clobbers a live transcript dump.
  const h = harness(t, [block], { dump: false });
  await settle();

  const diagnose = h.commands().find((c) => c.id === "opencode-fold-diffs.diagnose");
  diagnose.run();
  assert.match(h.toasts.at(-1).message, /transcript: yes · blocks: 1 · folded: 1 · stats: on/);
});

test("ships a server entry so the plugin is discovered by id", async () => {
  const server = await import("../index.js");
  assert.equal(server.default.id, "opencode-fold-diffs");
  assert.equal(typeof server.default.setup, "function");
});

test("folds nothing outside a session route", async (t) => {
  const { block, body } = editBlock();
  const h = harness(t, [block]);
  h.context.ui.router.current = () => ({ type: "home" });
  await settle();

  assert.equal(body.visible, true);
});

// --- bash commands -------------------------------------------------------
//
// The host already collapses a long command to two lines and its output to ten,
// both with click-to-expand, so folding commands is opt-in on V2. The block is
// a box wrapping the "$ command" text, the output, and the host's own expand
// hint. It carries no header of its own.
function shellBlock({ lines = 20, output = "ok", hint = true, running = false, title } = {}) {
  const body = Array.from({ length: lines }, (_, i) => `print(${i})`).join("\n");
  const first = running ? new Box([new Text(body)]) : new Text("$ " + body);
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
  const h = harness(t, [block]);
  await settle();

  assert.equal(cmd.visible, true);
  assert.equal(cmd.onMouseUp, undefined);
});

test("folds a long bash command to its first row when enabled", async (t) => {
  const { block, cmd, wrap } = shellBlock();
  const h = harness(t, [block], { bash: true });
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
  const h = harness(t, [block], { bash: true });
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
  const h = harness(t, [block], { bash: true });
  h.context.renderer.getSelection = () => ({ getSelectedText: () => "print(3)" });
  await settle();

  cmd.onMouseUp(click());
  assert.equal(cmd.visible, true);
  assert.equal(cmd.maxHeight, 1);
});

test("short and still-running commands are left alone", async (t) => {
  const short = shellBlock({ lines: 3 });
  const running = shellBlock({ running: true });
  const h = harness(t, [short.block, running.block], { bash: true });
  await settle();

  assert.equal(short.cmd.visible, true);
  assert.equal(running.cmd.visible, true);
  assert.equal(running.cmd.onMouseUp, undefined);
});

test("bash_lines sets how much of the command survives", async (t) => {
  const { block, cmd } = shellBlock();
  const h = harness(t, [block], { bash: true, bash_lines: 3 });
  await settle();

  assert.equal(cmd.visible, true);
  assert.equal(cmd.maxHeight, 3);
});

test("ctrl+o folds and unfolds commands alongside diffs", async (t) => {
  const edit = editBlock();
  const shell = shellBlock();
  const h = harness(t, [edit.block, shell.block], { bash: true });
  await settle();

  h.run();
  assert.equal(edit.body.visible, true);
  assert.equal(shell.cmd.visible, true);
  assert.match(h.toasts.at(-1).message, /Unfolded 2 blocks/);

  h.run();
  assert.equal(edit.body.visible, false);
  assert.equal(shell.cmd.maxHeight, 1);
});
