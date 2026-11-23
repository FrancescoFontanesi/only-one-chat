// The lines that open each block of the facts' text (ADR 0048). Their producers
// write them and the chat's thread reads the text back by them, so both take
// them from here. No imports: the webview bundles this file as it is.

/** The files the whole request changed. Older chats wrote `Files changed:`. */
export const FILES_HEADER = 'Files changed since the request began:';
/** The only line under FILES_HEADER when the workspace could not be compared. */
export const FILES_UNAVAILABLE =
  '- unavailable: the workspace has too many files or could not be read';
/** The files the implementer's last turn changed (ADR 0041). */
export const TURN_FILES_HEADER = "Files changed by the implementer's last turn:";
/** A verification command the facts ran, followed by the command and its exit. */
export const VERIFY_PREFIX = 'Verification run by the runtime: ';
export const FAILED_TESTS_HEADER = 'Failed tests:';
export const OUTPUT_HEADER = 'Last lines of output:';
/** The line on the configured verification command, after the files. */
export const CONFIGURED_COMMAND_PREFIX = 'Configured runtime verification command: ';
export const NO_CONFIGURED_COMMAND = 'No runtime verification command configured.';
/** The checks on the diff (ADR 0030, 0046): a `- ` line per flag, or `- no flags`. */
export const DIFF_CHECKS_HEADER = 'Runtime diff checks (flags for review):';
export const NO_FLAGS = '- no flags';
/** Changed files too large to check, after the flags. */
export const DIFF_CHECKS_SKIPPED_PREFIX = 'Skipped because they were too large: ';
export const DIFF_CHECKS_UNAVAILABLE =
  'The runtime skipped diff checks because there was no workspace checkpoint.';
/** One line: `level (score) — reasons.` (ADR 0041). */
export const RISK_PREFIX = 'Change risk estimated by the runtime: ';
/** The checks of a report or a review against the brief (ADR 0031, 0042), as `${title}${suffix}`. */
export const CONTRACT_SUFFIX = ', made by the runtime:';
/** A failed check before the review, sent back to the implementer without a review (ADR 0041). */
export const GATE_SENT_BACK_HEADER =
  'Runtime check before the review failed: sent back to the implementer automatically. This is not a review.';
