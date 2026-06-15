// @trace/cursor-reader — reads Cursor (GUI) sessions from its state.vscdb SQLite
// store. Depends only on node:sqlite + node:fs; zero trace coupling.
//
// Public surface is built across the feature's task slices:
//   - resolveFocusedComposer(repoPath, opts?)  (cursor-reader-tracer)
//   - readComposer(composerId, opts?)          (cursor-reader-tracer)
//   - readComposerTail(composerId, limit, opts?) (bubble-projection)
//
// See docs/cursor-reader-design.md for the verified storage schema.

export {};
