# 0002. Reuse policy for reference sources

- Status: Accepted (2026-10-18)

## Context

At bootstrap, the intent was to build an independent project that could be published under MIT without taking on attribution obligations from copied reference code. The project license is currently deferred under [ADR 0035](0035-handoff-tools-and-english.md).

The reference projects use MIT (usturlab, Augani, and VS Code samples) and Apache-2.0 (Codex). Both licenses allow reuse and require preserving copyright notices when substantial portions are copied. Apache-2.0 also requires preserving the NOTICE and indicating changes. Independent implementation avoids attribution obligations from copying reference code.

## Decision

1. References supply **ideas, architectures, patterns, and observable behavior**. Copying code, translating it line by line, and mechanically paraphrasing it are prohibited.
2. Implement from this project's requirements. Keep reference files closed while writing the corresponding code to avoid using them as transcription templates.
3. Unprotectable or commonplace material may be used without attribution. Examples include protocol message names, data formats, CLI flags, and standard VS Code API patterns documented by Microsoft, such as a nonce-based CSP.
4. Direct reuse requires a new ADR approved by the user on a case-by-case basis, with `THIRD_PARTY_NOTICES.md`.
5. Code from proprietary extensions, including the official Codex extension, is out of scope even as reading material.

## Consequences

- The repository carries no notices for copied reference code. npm dependencies have their own licenses and are distributed separately from the repository.
- The reuse policy applies to everyone who works on the repository, including agents.
- MIT was an initial project licensing proposal. The project currently has no declared license. An explicit licensing decision is required before public distribution.
