// Global test guard: neutralize cloud sync for the whole suite.
//
// Many CLI tests spawn `trace` with an isolated TRACE_DB but still inherit the
// developer's real environment, including HOME (so auth.json/key.json resolve
// to the real ~/.trace credentials). The one remaining gate before a task
// created in a test lands on a live server is a resolvable sync URL: the CLI
// only pushes when TRACE_SERVER_URL is set, or a config.json beside the
// database supplies one. Tests use throwaway temp databases with no such
// config.json, so stripping TRACE_SERVER_URL here guarantees background sync
// soft-no-ops no matter how a given test handles HOME — no fixtures can reach
// the real sync server.
delete process.env.TRACE_SERVER_URL;
