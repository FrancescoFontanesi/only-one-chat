# 0047. Workspace reads with a stat cache, and structural guards

Status: Accepted.

## Context

The runtime reads the whole workspace many times per task, through two readers:

- `snapshot()` in `apps/vscode/src/session/facts.ts`, for the facts and the
  per-turn baseline. It reads and hashes every non-ignored file, with no size
  limit.
- `CheckpointStore` in `apps/vscode/src/session/checkpoints.ts`, for the
  request, task, guard, verification and diff-check checkpoints. It stats every
  file, reads and hashes those up to 2 MiB, and checks each blob on disk with
  `existsSync`.

Neither keeps anything between reads. A reviewed task with one round walks the
workspace about 15 to 25 times, counted from the call sites. About half of them
come from `saveTaskProgress`, which takes a checkpoint at every save.

Measured on 2026-11-23, Node 24 on Windows (NTFS), with files of about 1.8 KB,
median of 3:

| Operation                  | 1,000 files | 5,000 files |
| -------------------------- | ----------- | ----------- |
| `snapshot()`               | 147 ms      | 487 ms      |
| `snapshot()` + `changes()` | 166 ms      | 411 ms      |
| `take()`, cold             | 1,154 ms    | 5,815 ms    |
| `take()`, warm             | 191 ms      | 864 ms      |
| `review()`                 | 182 ms      | 804 ms      |

At 5,000 files that is about 10 to 15 s of I/O per task.

There are also structural gaps:

- **Session code imports the webview layer:**
  - eleven files in `apps/vscode/src/session/` import types from
    `apps/vscode/src/webview/protocol.ts`;
  - two import values: `mentions.ts` imports `refs.ts`, `node.ts` imports
    `NODE_NAME_LENGTH`.
- **`tests/boundaries.test.ts` checks only two things:** `vscode` stays out of
  the packages, and nothing imports `references/`.
- **There are no value import cycles today** across the 94 source files, but
  nothing keeps it so.
- **Several files are over 2,000 lines,** and nothing stops them growing.

## Decision

1. **One shared stat cache.**
   - **What it maps:** a module maps an absolute path and `(size, mtimeMs)` to
     the content hash. `snapshot()` and `CheckpointStore` both use it, and stay
     separate readers. The facts' format does not change.
   - **When it reads anyway:** a file is read and hashed again when its size or
     `mtimeMs` changed, or when its `mtimeMs` is within 2 s of the scan start or
     after it. That is Git's rule for racy timestamps: a same-size edit in the
     same instant is never missed.
2. **`snapshot()` stops at 2 MiB, as checkpoints do.** A larger file is never
   read into memory. Its fingerprint is built from its size and `mtimeMs`, so
   `changes()` still sees it added, removed or resized.
3. **`CheckpointStore` remembers the blobs it has verified or written** in this
   instance, and skips `existsSync` for them.
   - **When the memory is wrong:** if the blob folder is gone (the chat's
     checkpoints deleted, storage cleaned), every checkpoint first forgets the
     known blobs and writes them again.
   - **A single blob missing:** the read is still an error, as today, and that
     blob is forgotten, so the next checkpoint writes it again.
4. **A task save reuses the last checkpoint when nothing could have written
   since.**
   - **What resets it:** an agent turn that ended (implementer or reviewer,
     guard included), or a verification command run in the working folder.
   - **What it preserves:** the semantics of
     [ADR 0039](0039-resume-interrupted-tasks.md). The recorded checkpoint
     still equals the workspace at the last boundary that could change it.
     User edits made in between still show up as changes on recovery, which is
     the cautious outcome that ADR asks for.
5. **Shared types and values move to `apps/vscode/src/shared/`.**
   - **What moves:** what both session code and the webview need: the protocol
     types the session uses, the `@path` reference parser and
     `NODE_NAME_LENGTH`.
   - **Who imports it:** `session/` and `webview/` both import from `shared/`.
     `session/` never imports from `webview/`.
6. **Three guards in `tests/boundaries.test.ts`:**
   1. **No cycle of value imports** among the project sources.
   2. **`apps/vscode/src/session/` and `apps/vscode/src/shared/` import
      nothing from the webview layer** (`apps/vscode/src/webview/`,
      `apps/vscode/webview/`) nor from Preact, neither values nor types.
   3. **A ceiling on lines.**
      - **The default:** 800 lines for every source file, new ones included.
      - **The legacy allowlist:** each file above 800 today gets its current
        count plus 30.
      - **Changing an entry:** only downwards, when a file shrinks.
7. **The I/O benchmark is versioned** in `dev/`, to repeat the measurement.

Splitting `chat.ts` is left to a later, dedicated change.

## Measurement

The same benchmark after the change, `node dev/io-bench.ts`, on 2026-11-23,
median of 3. The files are backdated by an hour, as in a real workspace, so
that the 2 s rule does not read them all again:

| Operation                  | 1,000 files: before | after  | 5,000 files: before | after    |
| -------------------------- | ------------------- | ------ | ------------------- | -------- |
| `snapshot()`, first        | 147 ms              | 187 ms | 487 ms              | 715 ms   |
| `snapshot()`, cached       | —                   | 62 ms  | —                   | 194 ms   |
| `snapshot()` + `changes()` | 166 ms              | 60 ms  | 411 ms              | 204 ms   |
| `take()`, cold             | 1,154 ms            | 993 ms | 5,815 ms            | 5,689 ms |
| `take()`, warm             | 191 ms              | 66 ms  | 864 ms              | 205 ms   |
| `review()`                 | 182 ms              | 62 ms  | 804 ms              | 216 ms   |

- **Repeated walks cost about a quarter:** 20 walks of 5,000 files go from
  about 15 s to about 4 s.
- **The first walk costs more,** +47% at 5,000 files, for the extra `stat` and
  filling the cache. It is paid once per session.
- **The first checkpoint is unchanged,** about 5.7 s at 5,000 files, since it
  writes every blob.
- **Checkpoint reuse:** in a full task of the unit tests, 6 saves take 3
  checkpoints. A restart on a save that reused a checkpoint resumes from it,
  with a new store, and still reports later user edits.

## Approximations

- **The cache is dropped whole** when it reaches 50,000 entries, not pruned. It
  is marked in the code as a shortcut, to revisit if walks start to thrash.
- **Git's racy rule has Git's limit.** An edit that keeps the same size and
  sets the old `mtimeMs` back is not seen. Only tools that reset the time on
  purpose can do that.

## Budget

- **Code:**
  - about 80 lines for the cache and its use;
  - about 20 for the 2 MiB rule;
  - about 15 for the blob set;
  - about 25 for checkpoint reuse;
  - about 100 for the guards;
  - the move to `shared/`, about 30 lines of imports.
- **Tests:**
  - an edit within 2 s at the same size;
  - an `mtimeMs` in the future;
  - a file over 2 MiB;
  - removal and rename;
  - checkpoint reuse and its reset.
- **No dependency,** no setting, no change to the security model, the facts'
  format or the task record.
