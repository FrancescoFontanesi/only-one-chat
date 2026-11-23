# 0048. The thread shows the runtime's evidence apart, and the brief's scope as links

Status: Accepted.

## Context

ADRs 0041 to 0047 added evidence that the runtime produces by itself, not a
model. An audit of the webview found that part of it did not reach the user, or
reached them in the wrong place:

- **The facts were misread.** `readFacts` put every `- ` line in the changed
  files until a verification heading. The session calls `verifiedFacts` with no
  command, so that heading never came. The diff checks' flags (ADR 0030, 0046,
  the self-comparison included) and `- no flags` showed up as changed files.
  The risk line (ADR 0041) had no `- `, so it was dropped. So were the files
  over 2 MiB skipped by the checks. With more than 5,000 files, the
  `- unavailable: …` line was listed as a file too.
- **The check before the review (ADR 0041)** sent a failure back to the
  implementer on its own, with no card. The thread showed a second implementer
  turn with no reason given.
- **The delegation waiting for approval** showed the brief as plain text. Its
  `paths` (ADR 0042) were not links, because they have no `@`.
- **The checks of a report against the brief** (`scope-exceeded`,
  `files-undeclared`, ADR 0031 and 0042) showed as a generic warning, which
  looked like any other notice.

## Decision

1. **The facts stay text.** Their transport does not change, and neither does
   the format of saved chats.
   - **Shared headers:** the lines that open each block move to
     `packages/runtime/src/fact-headers.ts`, a file with no imports. Their
     producers (`facts.ts`, `shortcuts.ts`, `risk.ts`, `contract.ts`,
     `chat.ts`) write them from there, and `readFacts` reads them from there.
   - **What the thread shows apart:**
     - the changed files, or "not compared" when the workspace is over the
       limit;
     - the last turn's files, when they differ;
     - the diff checks, one line per flag, or "no flags", or "not run";
     - the risk, with its level, score and reasons;
     - the verification command, as before.
   - **The verification output** now ends where the following blocks begin.
2. **The runtime's checks of a report or review** get their own card,
   "RUNTIME CHECKS", read from the header `contractFacts` writes. It is kept
   apart from the reviewer's findings.
3. **The check before the review** emits a `gate_sent_back` event. The thread
   shows "CHECK BEFORE REVIEW · SENT BACK · NOT A REVIEW", with the result.
   This is a notice only. No approval step is added: the send-back still goes
   on by itself.
4. **The delegation's scope as links.**
   - **Where the data comes from:** `paths` and `references` travel as
     structured fields of the approval update (`shared/protocol.ts`) and of the
     saved draft. They are not extracted from the brief's Markdown, and are
     absent when the user wrote or edited the brief.
   - **What happens on a click:**
     - a reference opens the file, at its range when it has one;
     - a folder path (`src/`) is revealed in the explorer, as `openFile`
       already does;
     - a path the folder does not have yet stays plain text, and joins the
       "not found" line.
5. **Risk is display only.** It does not change the flow or any policy.

## Kept out of the UI

- **Prompt modules** (ADR 0045) and the rules they carry.
- **Schema and reviewer repair turns** (ADR 0040), unless they run out and
  end in an error, as today.
- **The I/O cache** (ADR 0047): hits, re-reads, the racy rule, blob and
  checkpoint ids, and when a task checkpoint is reused.
- **Brief references dropped silently** (root `AGENTS.md`, `CLAUDE.md`,
  duplicates).
- **The configured verification command line.**
- **The bench's step counts.**
- **The number of tasks in the implementer session** (ADR 0043). It is left to
  a later change.

## Consequences

- **Older chats read better too:** their saved facts already carry the flags
  and the risk lines, which are now shown in place.
- **A new block of the facts needs its header** in `fact-headers.ts`. The
  round-trip tests feed `readFacts` what the real producers write, so a header
  that changes on one side only fails them.
- **`Thread.tsx` shrank:** the cards moved to `Facts.tsx` in a structural
  commit before this one, and the file's legacy ceiling went down from 919 to
  847 lines.

## Limits

- **An output line that looks like a header:** the thread ends the
  verification output at the first line that starts like a later block's
  header (the command line, the diff checks, the risk). The rest of that
  output is then not shown in the card. The leader and the reviewer still get
  the facts' full text: only the display is affected.
- **Rendering was checked in headless Chrome only:** the webview bundle was fed
  a sample thread. Clicks inside VS Code were not run automatically: revealing
  a folder in the explorer and selecting a reference's lines are left to a
  manual check. The host's `openFile` was not changed.
