# ADR-064: Budget spreadsheets are edited in Univer and converted in a sandboxed frame

Date: 2026-11-26
Status: Accepted

## Context

The owner wants to open a budget spreadsheet in Curia, edit it, and later work on it with the EA. Univer's grid is
Apache-2.0, but its official file import and export are commercially licensed packages that need a conversion server.
The options were those paid packages; Curia's own reader (values and formulas only); or a community converter (MIT)
running in the browser. The owner chose a community converter. The grid also needs styles and images that the console's
Content-Security-Policy blocks.

## Decision

- **Grid:** `@univerjs/presets` and `@univerjs/preset-sheets-core`, pinned to 1.5.2 (older than the repository's
  seven-day quarantine at the time).
- **Converter:** `@zwight/luckyexcel` 1.1.6, chosen over a newer alternative because its source is public. It has one
  maintainer and targets an older Univer, and one of its dependencies contains an `eval` it does not reach for these
  files. It therefore runs only in its own page, sandboxed to an opaque origin with `connect-src 'none'`: no cookies, no
  reach into the console, no network. Because that origin is "null", the built assets under `/assets/` are served with
  `Access-Control-Allow-Origin: *` to it, without credentials; they hold no data.
- **Nothing from the converter is trusted.** The server copies only known fields (cells, formulas, plain styles, merges,
  sizes) and stores that. The uploaded file is never sent to the server or kept.
- **Policy:** only `/budget/sheet-frame` allows Univer's three stylesheets by hash and `data:` images, and may be framed
  by Curia itself. Scripts stay `'self'`.
- Sheets live in `budget_sheets` with a version number (a stale save is refused) and expire 14 days after their last
  change. No agent can read them yet.

## Consequences

- No commercial licence and no extra service. No Excel export; charts, pictures and some formatting are lost, so the
  owner should check figures against the original.
- Upgrading Univer means recomputing the style hashes (a test pins the versions). Menus or dialogs that add other styles
  would be unstyled until their hashes are added.
- The sheet page downloads about 1.5 MB (compressed) of grid code, and the converter about 430 KB.
- Giving the EA read or write access to sheets is a separate decision that amends ADR-062.
