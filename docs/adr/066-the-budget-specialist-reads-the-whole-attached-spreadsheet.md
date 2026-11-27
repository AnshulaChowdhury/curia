# ADR-066: The budget specialist reads the whole attached spreadsheet

Date: 2026-11-27
Status: Accepted (amends ADR-065)

## Context

ADR-065 gave the budget specialist a paged read of the visible parts of the attached sheet: 300 cells a call, hidden
tabs, rows and columns left out. The owner needs the assistant to read and understand the entire file, and a
household budget file often keeps tabs hidden. Numbers also arrived without their formats, so dates read as serial numbers.

## Decision

- `budget-sheet-read` returns **every cell of every tab**, with values and formulas. Hidden tabs, rows and columns are
  **included and marked as hidden** (owner's requirement).
- One read carries up to about 100,000 characters, so a typical household file comes back whole; a larger one is read on
  with `from`. The limit stays under the cap on a tool result.
- Dates and percentages are written as the sheet shows them.
- Everything else in ADR-065 stands: only the sheet attached to the asking web chat, read-only, tags stripped and
  instruction-like text flagged.

## Consequences

- **Hidden cells now reach the model provider, audit logs and conversation memory.** Before attaching a file, the owner
  should remove anything in it they do not want read.
- A file from someone else can carry text the owner cannot see on screen. Scanning covers it and it is marked hidden, but
  pattern matching will not catch every attempt to steer an agent.
- A read costs more model input than before; a file near the 20,000-cell limit takes several reads and can use much of
  the context window.
- Cell comments, charts and images are still not read.
