# ADR-057: Retire the bearer message routes; console chat is the only message ingress

Date: 2026-10-30
Status: Accepted

## Context

Curia had two HTTP paths that both published an inbound message and streamed agent events:

| | Bearer routes (removed) | Console |
|---|---|---|
| Routes | `POST /api/messages`, `GET /api/messages/stream` | `POST /api/chat/messages`, `GET /api/chat/stream`, `GET /api/chat/history` |
| Auth | Bearer `API_TOKEN` | `curia_session` cookie or `x-web-bootstrap-secret` |
| Bus channel | `http` | `web` |
| Reply | One JSON body, blocking up to 120s | `202 { conversationId }`; the reply arrives on SSE |

#999 asked whether to keep both, retire the bearer routes, or merge them. A first pass kept both because `curia-docs` describes `POST /api/messages` as the programmatic API. That is circular. Those pages document the routes. They are not a client, and no other repository in this account calls them.

### Who called what

**`/api/messages` and `/api/messages/stream`**

- No runtime caller in `apps/`, `scripts/`, workflows, `install.sh`, or `docker-compose.yml`.
- The callers were tests: `tests/integration/http-api.test.ts`, plus the bearer-path list in `tests/unit/channels/http/auth.test.ts`.
- `josephfung/curia-docs` documents the routes (`references/http-api.mdx`, `references/http-api-messages.mdx`, `references/http-api-stream.mdx`, `channels/http.mdx`). `josephfung/curia-website` does not call them.
- On a default install the documented curl did not reach the coordinator anyway. `sender_id` defaulted to `http-user`, `http.unknown_sender` is `ignore`, and `http` is not a linkable channel identity, so the response was 403.

**`/api/chat/*`**

- Runtime client: `apps/console/src/pages/chat/useChatSession.ts`. It posts, opens `/api/chat/stream?conversationId=…` for the turn, and pages history.
- The one-release 308 from `/api/kg/chat/*` lands on the same handlers.
- #2341 (open) adds more devices on this surface.

**Left in place on purpose**

- The `http` catalog entry is the Fastify process. `isToggleable: false` is the operator-lockout safeguard (spec 04). Removing it would take down the console.
- `API_TOKEN` is required at boot. `validateBearerToken` fail-opens when the token is missing, so the token still guards every route that does not authenticate itself, including `GET /api/agents/status`.
- `GET /api/health` stays unauthenticated.
- The dispatcher still publishes a pending-approval outbound when Gate C escalates a reply whose channel is `http` (#1733). No route waits on it now. Unit tests still cover that branch. Removing the publish is a separate change.

The shared `sseClients` set was a problem only because both streams registered clients. With one stream left, that bleed is gone.

## Decision

Remove `POST /api/messages` and `GET /api/messages/stream`, and the route module that served them.

Do not remove the HTTP adapter, the `http` catalog entry, `API_TOKEN`, bearer enforcement, or the `http` row in `config/channel-trust.yaml`.

The integration test that sent a message and read the agent reply now posts to `/api/chat/messages` (session secret) and reads the reply from `outbound.message`. The bearer-hook tests target `GET /api/agents/status`, which still requires the token. The unknown-sender 403 test and the trust-score test existed to drive the blocking `http` route. Dispatcher unit tests already cover trust scoring and the pending-approval outbound, so those HTTP cases are not recreated on `/api/chat`. Console chat is the principal, not an unknown `http` sender.

#2380 (split the SSE clients) and #2381 (the documented curl 403s) are withdrawn. Both assumed the bearer routes would stay.

`curia-docs` still describes the removed routes (josephfung/curia-docs#62). That site needs its own edit. It is not a reason to keep the code.

## Consequences

- External scripts that followed the public docs get 404 (or the console fallback) instead of a chat reply. That contract had no in-repo client, and the default install already rejected the documented caller.
- The console is unchanged. It already used `/api/chat`.
- An unfiltered programmatic stream can no longer receive console chat HTML, because that stream is gone.
- `channelId: 'http'` can still appear on a Gate C pending outbound and in older stored turns. History labels and the trust policy stay so those rows still read.
- Spec 04's "future web dashboard would use the HTTP API" sentence is replaced. The dashboard uses `/api/chat`.
