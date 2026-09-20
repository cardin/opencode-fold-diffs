// Server entrypoint for opencode-fold-diffs.
//
// All rendering happens in the CLI runtime (tui.js). This file only exists so a
// local plugin directory is a complete plugin: OpenCode discovers a plugin
// directory by its index (server) entry and loads the `tui` entry beside it, so
// the plugin shows up by id instead of as an anonymous entry.
//
// `Plugin.define()` is an identity helper, so a plain { id, setup } object is
// the same definition without a runtime dependency on @opencode/plugin.

export const PLUGIN_ID = "opencode-fold-diffs";

export default {
  id: PLUGIN_ID,
  setup() {
    // Intentional no-op: the transcript folding is registered by tui.js.
  },
};
