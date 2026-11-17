# Development Rules

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!")
- Technical prose only, be direct
- Use concise, clear, simple language. Define unavoidable jargon before using it.
- Explain non-trivial designs and problems as: problem, concrete example or short trace, then solution. State why the solution is necessary and distinguish it from optional complexity.
- Prefer concrete behavior and small illustrations over abstract summaries, dense terminology, or unexplained lists of changes.
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Code Style

- When reproducing a feature, first understand the original mechanism and agree on which behaviors to keep. Use the simplest implementation that preserves those behaviors, including what must remain true if an operation fails.
- Write the main flow in execution order so a reader can see what triggers each step and where state changes. Extract details when doing so makes that sequence easier to follow.
- Prefer plain data and direct function calls. Reuse concepts the reader already knows; introduce an abstraction only when the feature at hand needs it.
- Prefer the version that is easier to follow over one that merely uses fewer lines.
- Use short Chinese comments to mark the stages of a longer flow and explain non-obvious choices or deliberate simplifications. Let the code describe straightforward operations.

## Code Quality

- Read each file you plan to edit in full. Before proposing a fix, check how similar code handles the same case. Follow that pattern or explain why it does not fit.
- Avoid `any`. Treat untrusted data, such as model responses, tool arguments, and saved session records, as `unknown` until validated. Do not repeat those checks in code that already receives a verified type.
- Check the type declarations shipped with the installed dependency before using an unfamiliar API. If an outdated dependency causes a type error, update it instead of weakening types or removing working behavior.
- Use top-level imports, including `import type` for types. Avoid inline `import()` expressions for values and types.
- Inline a one-line helper used only once unless its name makes the caller easier to understand.
- Ask before removing behavior that appears intentional unless the user already requested its removal. Add backward compatibility only when requested.

## Project Context

- Record important plans and decisions in `docs/plans/`, including the reasons for choices that should guide later work.
- Keep feature specifications in `docs/specs/`. Describe the agreed scope and expected behavior.
- Before proposing or implementing a feature, read the plans and any existing spec relevant to that feature.
- When implementing a new feature, document how it works in `docs/<feature-name>.md`. Update that document as the feature evolves.
