# ADR-057: Keep the bearer message API and the console chat API, and split their SSE clients

Date: 2026-10-30
Status: Accepted

## Context

Curia exposes two HTTP paths that both publish an inbound message and stream agent events back (#999, follow-up to #985):

| | Programmatic | Console |
|---|---|---|
| Routes | `POST /api/messages`, `GET /api/messages/stream` | `POST /api/chat/messages`, `GET /api/chat/stream`, `GET /api/chat/history` |
| Earlier path | — | `/api/kg/chat/*`, 308 to `/api/chat/*` for one release (#872) |
| Auth | Bearer `API_TOKEN` | `curia_session` cookie or `x-web-bootstrap-secret` |
| Bus channel | `http` | `web` |
| Trust (`config/channel-trust.yaml`) | medium, `unknown_sender: ignore` | high, `unknown_sender: allow` |
| Who the sender is | `sender_id` from the body, default `http-user`. Resolved like any other channel. | Always the principal (`contact-resolver` short-circuit) |
| Reply | One JSON body, blocking up to 120s | `202 { conversationId }`; the reply arrives on SSE |
| Registered | Always, with the HTTP adapter | Only when `webAppBootstrapSecret` is set |

They share one `EventRouter`: the `pendingResponses` map, and one `sseClients` set. `broadcastToSseClients` filters on `conversationId` only. An `outbound.message` for `http` or `web` is rendered to HTML and written to every client that did not set a conversation filter (`src/channels/http/event-router.ts`). A `GET /api/messages/stream` with no `conversation_id` therefore receives console chat, including that HTML. The console always sends `conversationId` (`apps/console/src/pages/chat/useChatSession.ts`), so the bleed is one-way today. Ant Farm uses a separate client set and is not part of this.

The comment next to that set says both routes use the bootstrap secret. They do not. `/api/messages` is bearer-authenticated. `/api/chat` is on `SELF_AUTHED_API_PREFIXES` and calls `assertSecret`. The dispatcher reads trust from `channel-trust.yaml`, not from the `metadata.trustLevel: 'medium'` both routes still stamp. That stamp does not make the two channels the same trust.

Three options were on the table (#999):

- **A.** Keep both. Tag each SSE client with its channel and filter on it.
- **B.** Remove `/api/messages*`, and with it the HTTP catalog entry, bearer auth, and the `http` trust policy.
- **C.** One route layer, pluggable auth.

### Who calls what

**`POST /api/messages` and `GET /api/messages/stream`**

- No runtime caller in this repo. Searched `apps/`, `scripts/`, `tests/scenarios/`, workflows, `install.sh`, and `docker-compose.yml`. Callers are tests: `tests/integration/http-api.test.ts` and the bearer-auth case list in `tests/unit/channels/http/auth.test.ts`.
- Published contract, not a caller: `josephfung/curia-docs` (`references/http-api.mdx`, `references/http-api-messages.mdx`, `references/http-api-stream.mdx`, `channels/http.mdx`, `channels/how-channels-work.mdx`), live at docs.meetcuria.com. Those pages describe `POST /api/messages` as the programmatic way to talk to Curia, with bearer auth, and they separate it from session-cookie dashboard routes. `josephfung/curia-website` has no API client. GitHub code search across the owner was rate-limited; the public repos visible from this account are those three. Private scripts outside them are unknown.
- Operational mention, not a sender: ADR-055 records that curia-deploy's Caddyfile already special-cases `/api/messages/stream` so proxies do not compress it.
- Spec 04, ADR-053, and `publishRelayGateCPendingStatus` (`src/dispatch/dispatcher.ts`) all treat a blocking `POST /api/messages` as a real channel. ADR-053 says a second POST on the same `conversation_id` is injected, the first request resolves as superseded, and the second carries the reply.

**`/api/chat/*`**

- Runtime: `apps/console/src/pages/chat/useChatSession.ts` only. It loads history, opens `/api/chat/stream?conversationId=…` for the turn, and POSTs `/api/chat/messages`.
- The one-release 308 from `/api/kg/chat/*` (`src/channels/http/routes/legacy-kg-aliases.ts`) lands on these same handlers. It is not a third surface.
- #2341 (open) adds more devices on this surface. It does not add a caller of `/api/messages`.
- Tests live beside the route (`tests/unit/channels/http/chat-routes.test.ts`).

**Not these two surfaces, and not removed by keeping or dropping the message routes**

- `GET /api/health` is unauthenticated. Docker, the DAST plan, and the console health card call it.
- `GET /api/agents/status` is bearer-authenticated and documented in curia-docs. The console does not call it.
- `API_TOKEN` is required at boot (`src/index.ts`). `validateBearerToken` fail-opens when the token is missing, so an empty vault row would expose every route that is not self-authenticated. The token is the gate for those routes, not a credential that exists only for `/api/messages`.
- The `http` catalog entry (`src/channels/catalog.ts`) is the Fastify adapter. `isToggleable: false` is the operator-lockout safeguard: disabling HTTP would take down the console and the registry API (spec 04). It is not a switch for the message routes alone.

### The documented caller does not get in

On a default install the curl in the public docs does not reach the coordinator. The body omits `sender_id`, so the route uses `http-user`. `http` is not a principal channel. `unknown_sender: ignore` publishes `message.rejected`, and the route returns 403. `http` is not in `LINKABLE_CHANNEL_IDENTITIES`, and `messages.ts` does not call `ensureChannelContact`, so there is no supported way to insert the identity that would pass. Tests that expect 200 stub the resolver or set `unknownSender: 'allow'`. That gap is #2381. It is a reason to fix admission, not a reason to delete a published route.

## Decision

**Option A.** Keep both surfaces. They are different channels with different auth, trust, identity, and reply shapes. The public docs already tell callers that. Bearer `API_TOKEN` is an install-wide secret at medium trust. The session secret is the principal at high trust. Collapsing them would either give the token principal authority or take the synchronous JSON reply away from the programmatic contract.

**Not B.** No in-repo runtime caller is what an integration API looks like. The deciding external evidence is the published curia-docs contract, plus ADR-053's specified behavior for a second `POST /api/messages`. B as written also deletes the wrong things: the catalog entry is the whole HTTP server, and bearer auth still guards `/api/agents/status` and every future route that forgets to self-authenticate.

**Not C.** One route with two auth plugins would still need two channel ids and two response contracts (blocking JSON versus `202` plus history). That is A, with a larger routing surface.

**SSE fix (#2380).** Tag each `SseClient` with `channelId: 'http' | 'web'`. `broadcastToSseClients` skips a client when the event's channel disagrees. `outbound.message` and `message.rejected` carry a channel. `tool.invoke` and `tool.result` do not: record `conversationId → channelId` at publish time in `messages.ts` and `chat.ts`, and apply that record on the way out. Events for a conversation that was never recorded (email, Signal, and the rest) keep today's conversation filter. `agent.discuss` has neither a channel nor a conversation and stays a fan-out to both client kinds; it is process-wide observability, not chat content. Ant Farm stays on its own set. Correct the comment that claims both routes use the bootstrap secret.

This is not part of #2341. That issue's long-lived console streams are why the split should land before those streams stay open. The phone app does not own the channel boundary.

## Consequences

- Programmatic callers keep a blocking JSON reply and medium trust. The console keeps ack-and-stream, history, and the principal short-circuit. Neither gains the other's semantics.
- Until #2380, an unfiltered `/api/messages/stream` still receives console chat HTML. The console's own stream is filtered by `conversationId`, so it does not see other conversations. The two secrets are both operator-held, which limits who can open the unfiltered stream. It does not make the channels the same trust.
- Until #2381, the curl in the public docs receives 403 on a default install. Keeping the route means that mismatch stays a bug. The fix must not treat `API_TOKEN` as the `web` principal short-circuit unless a later ADR says so.
- `metadata.trustLevel: 'medium'` on both publishes is unused. The dispatcher uses `channel-trust.yaml`. Leave the stamp alone in #2380.
- Spec 04 still says the HTTP API is the interface a future web dashboard would use. The dashboard exists and uses `/api/chat`. This ADR is the correction; spec 04 should be aligned when that page is next edited, not as a behavior change here.
- No route, catalog entry, config key, or test is removed.
