# Brief format

Version 1 was defined in step 2 of the toolkit
([ADR 0009](decisions/0009-chatgpt-web-and-three-turn-layer.md)). The runtime recognizes
the format (`packages/runtime/src/brief.ts`). In `leader` mode, the leader reads the
brief as written and hands it off through the `delegate` tool. The pasted brief and
copied result retain their markers. See
[ADR 0035](decisions/0035-handoff-tools-and-english.md). ADR 0034 removed the gateway
introduced in ADR 0009.

## Purpose

- **The brief brings decisions from ChatGPT web into the extension.** It stays at a high
  level because ChatGPT cannot see the repository. It contains the conclusions and their
  rationale.
- **The implementer maps the brief to the actual code.** Its milestones define the
  implementer's work, which is the standard workflow. The `track` identifies the workstream.
  ADR 0034 removed the gateway that kept the history of briefs, specifications, and previous
  results. The ChatGPT conversation is private to that chat.
- **ChatGPT setup instructions** are in
  [templates/chatgpt-project-instructions.txt](templates/chatgpt-project-instructions.txt).
  - Paste them into a ChatGPT Project's instructions once per repository, replacing
    `{{PROJECT_ID}}` with the project ID.
  - The ChatGPT Project instruction length limit still needs checking.

## Format validation

The brief parser validates only the header and closing line. It passes the body as written.

- The first line is `<<<OOC-BRIEF v1 project=<id> track=<slug>`. The ID and slug consist
  of lowercase letters, digits, and hyphens. This protects against incorrect copies
  and briefs copied from another project.
- The last line is `OOC-BRIEF>>>`. A missing closing line signals a truncated copy, for
  example when three backticks appeared inside the block.

`parseBrief` reads only the header and closing line. If a required section is missing,
the leader flags it or asks for clarification.

## Structure

Use these sections in order with their English headings. Omit empty sections and use
short lists in the conversation's language.

| Section               | Required                          | Content                                                                  |
| --------------------- | --------------------------------- | ------------------------------------------------------------------------ |
| `Goal`                | Yes                               | What must be true at the end, in one or two sentences                    |
| `Context`             | If there is new information       | What changed since the last brief or result, and why                     |
| `Decisions`           | Yes                               | Binding decisions, one line each with the rationale                      |
| `Plan`                | For work with multiple milestones | Each milestone and its outcome, plus why the order matters if applicable |
| `Latitude`            | Where there is discretion         | What the agent may decide and report afterward                           |
| `Constraints`         | If any                            | Prohibited actions and work outside scope                                |
| `Acceptance criteria` | Yes                               | Numbered, verifiable, high-level behaviors                               |
| `Report`              | No                                | Additional information requested beyond the standard result              |

## Writing rules

- **Give each section one purpose.** Put decisions in `Decisions` and constraints in
  `Constraints`.
- **Describe milestone outcomes.** The `Plan` states what each milestone delivers.
  The implementer can see the code and chooses the files and functions.
- **Use verified repository facts.** Flag unknowns in `Latitude` or `Context`.
- **Refer to earlier briefs and results from the same workstream.** Include any relevant
  information that exists only in the chat.
- **Resolve open decisions before writing the brief.**
- **Indent code snippets by four spaces.** A triple-backtick fence would close the
  surrounding block.

## Example

```text
<<<OOC-BRIEF v1 project=calc track=user-functions

## Goal
Users can define their own functions and use them in expressions.

## Decisions
- Use def name(parameters) = expression to match assignment syntax.
- Parameters shadow global variables so name resolution is predictable.
- Reject recursion for now with a clear error.

## Latitude
- Choose how the evaluator represents functions.

## Constraints
- Preserve the command-line interface.

## Acceptance criteria
1. A defined function can be called in later expressions.
2. A call with the wrong number of arguments produces a clear error.
3. A recursive function produces a dedicated error without crashing.

OOC-BRIEF>>>
```
