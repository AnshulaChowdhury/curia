# ADR-061: The books run moves into Curia, with a stateless Python service for the rules

Date: 2026-11-04
Status: Accepted

## Context

The weekly books run lived on a Mac mini: a Python program read the bank files, applied the rules, compared with QuickBooks, asked a model about the rest, and pushed a batch to Curia for review. The model was called locally only to save on model costs. That left two homes for one job: a machine to keep alive, a books token and endpoints to guard, a heartbeat to monitor, and posting that Curia could not bind to the rows the owner approved.

Alternatives:

- **Keep the Mac mini.** No change, but every problem above stays.
- **Port the rules to TypeScript inside Curia.** One runtime, but the rules and their tests are Python, and more data-heavy Python work is coming.
- **A stateless Python service, called by Curia.** Rules stay where they are tested; Curia owns state, credentials and the model call. Rust was considered for the service and ruled out for now.

## Decision

- `books-service` (books repo, Dockerfile, Railway) runs the pipeline. It is stateless: each call carries the files and the last run's state, and returns a report, a batch, prompts for the model and the new state. It never sees QuickBooks credentials or a model key, never logs bank text, and listens only on Railway's private network behind a bearer token.
- Curia (`src/books/books-runner.ts`) drives the run: it lists uploads and the Drive folder, sends the files as `file-N.<ext>` (real names never leave Curia), reads QuickBooks through its one shared connection when the service asks (`qbo-lines.ts`, a port of `qbo_read.py`), asks the model for each prompt the service built (tool-less, standard tier), stores the batch, saves state in `books_pipeline_state` (migration 121), and only then marks files processed, so a failed run repeats.
- A run starts every five minutes when files are waiting, or from "Run now" on the Books page. After a failed scheduled run the next scheduled attempt waits an hour; a person can always retry. A run that cannot read QuickBooks stops: nothing is categorised without knowing what is already booked.
- The knowledge graph validates guesses; it does not do the lookup. The merchant-class taxonomy is left out.
- "Time saved" adds about three minutes for each row Curia sorted itself (a rough estimate).

## Consequences

- The Mac mini is no longer needed for bookkeeping. Retiring its path (books token and endpoints, heartbeat monitor, `temp_logs`, the LaunchDaemon plan) is later work.
- Posting to QuickBooks is unchanged here; binding `/books/qbo/create` to approved rows is the next phase.
- Model calls now cost money in Curia; they are limited to lines no rule or history covers.
- The service and Curia must agree on the request shape. The books repo's contract fixtures pin it.
