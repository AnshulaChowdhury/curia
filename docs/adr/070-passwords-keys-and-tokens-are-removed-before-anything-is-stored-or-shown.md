# ADR-070: Passwords, keys and tokens are removed before anything is stored or shown

Date: 2026-11-28
Status: Accepted

## Context

Messages, tool inputs and results, and agent replies were recorded as they arrived. Only some formats were masked, and
only in tool results and the AI call archive. The owner requires that secrets are neither stored nor shown, ahead of
keeping records indefinitely and adding a screen to read them.

## Decision

One redactor (`src/security/redact-secrets.ts`) replaces a secret with `[secret removed]`:

- **At the bus**, before the audit write-ahead and delivery, so no subscriber, channel or screen receives it. The
  publisher's own object is untouched: a tool still runs with the input it was given.
- **Again where text is stored or read**: audit logger, conversation memory and its summaries, AI call archive, tool
  results returned to a model, chat history. Reads clean rows written before this.
- **What counts**: known key and token formats; values after labels such as "password:"; credentials in links; secret-named
  fields; and the exact values held in the vault (secret-named and `user.*` entries) and in the environment.
- **Not matched**: bare long hex (event records carry content hashes), passcodes made only of digits and "code" values
  (one-time sign-in codes have to get through).
- The outbound content filter treats the marker as a secret, so a draft that tried to carry one is still held.

The vault stays the one place a secret is kept, encrypted. The one-time capture link is how to give Curia one.

## Consequences

- Detection is by shape, label and known value. **A password typed with nothing to identify it is not caught.**
- The model no longer sees a secret that arrives in a message, email or tool result, so it cannot pass one on. Flows that
  relied on that need the vault.
- A harmless value that looks like a secret is removed too, and cannot be recovered.
- Rows already stored are not rewritten: the audit log is append-only and hash-chained. They are masked when read.
- Server logs are not covered by this redactor.
