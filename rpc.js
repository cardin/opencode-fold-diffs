// The one method the server part exposes to the TUI part.
//
// OpenCode 2.2.3 passes options to a TUI plugin only from cli.json. An
// opencode.json server-plugin entry reaches the server context with its
// options, but the matching TUI entry is reduced to the bare package name, so
// the TUI never sees them. The server registers this method and the TUI asks
// for the values before configuring itself; cli.json still wins on a conflict.
//
// The definition is deliberately dependency-free: portable RPC accepts JSON
// Schema, so no @opencode/plugin or effect import is needed at runtime.
export const OPTIONS_RPC = {
  id: "opencode-fold-diffs.options",
  methods: {
    get: {
      input: { type: "object" },
      output: { type: "object" },
    },
  },
  events: {},
};
