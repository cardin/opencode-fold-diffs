// Server entrypoint for opencode-fold-diffs.
//
// Rendering happens in the CLI runtime (tui.js). This file exists so a local
// plugin directory is a complete plugin: OpenCode discovers a plugin directory
// by its index (server) entry and loads the `tui` entry beside it, so the plugin
// shows up by id instead of as an anonymous entry.
//
// It also bridges the options. A server plugin listed in opencode.json gets its
// `options` object; the TUI entry OpenCode derives from the same listing does
// not. Publishing them over RPC lets tui.js honour `folded`, `stats`, `key`,
// `bash` and the rest even when the plugin was installed with
// `opencode plugin add` instead of being configured in cli.json.
//
// `Plugin.define()` is an identity helper, so a plain { id, setup } object is
// the same definition without a runtime dependency on @opencode/plugin.

import { OPTIONS_RPC } from "./rpc.js";

export const PLUGIN_ID = "opencode-fold-diffs";

export default {
  id: PLUGIN_ID,
  async setup(context) {
    // Keep a copy: a host-side mutation of the context later must not change
    // what an already-running TUI asked for.
    const options =
      context?.options && typeof context.options === "object" && !Array.isArray(context.options)
        ? { ...context.options }
        : {};
    try {
      const registration = await context?.rpc?.register?.(OPTIONS_RPC, {
        // The RPC layer awaits every handler result, so a synchronous object
        // fails with "t(...).then is not a function"; always return a promise.
        async get() {
          return { options };
        },
      });
      return async () => {
        try {
          await registration?.dispose?.();
        } catch {}
      };
    } catch {
      // Older hosts have no portable RPC. The TUI then falls back to cli.json,
      // which is the only path 2.2.3 supports natively.
      return;
    }
  },
};
