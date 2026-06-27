# Portir Site Agent

A **stateless local relay**. Runs at a customer site, keeps one outbound WebSocket
to the Gateway, and executes commands against the local devices using Portir's
existing `src/hik` device layer (unchanged). It holds **no** controller or people
data: every command carries the target device's connection details inline
(`cmd.device`), and access events are pulled by the server *through* the agent. The
only thing persisted locally is the agent's own identity (`agent/data/identity.json`).

See [../docs/AGENT-ARCHITECTURE.md](../docs/AGENT-ARCHITECTURE.md) and
[../docs/GATEWAY-CONTRACT.md](../docs/GATEWAY-CONTRACT.md) for the full design.

## Run it (dev)

```bash
# 1. Gateway (the agent-facing seam; the server drives it)
npm run gateway              # listens on :4000, agent ws path /agent

# 2. Agent — the config is just the gateway URL, identical on every site
cp agent/config.example.json agent/config.json
npm run agent
```

The agent starts **unenrolled**: it generates an identity, logs a fingerprint, and waits.
Approve it in the app (**Admin → Site Agents → Waiting for approval**, match the
fingerprint). The server then pushes its token down the connection; it reconnects active.

```bash
curl http://localhost:4000/gw/agents      # who's connected (status/fingerprint)
```

`method` (for `/gw/invoke`) is exactly the `src/hik` adapter surface:
`getStatus, listDoors, openDoor, pushPerson, removePerson, getPersons, getAccessEvents`.
Each invoke carries a `device` payload (the controller's transport/host/port/credentials)
that the agent executes against directly.

## What's implemented

- **Zero-touch enrollment.** Same config everywhere; the agent self-generates a stable id
  + fingerprint (`agent/data/identity.json`), connects token-less → **pending**, and is
  approved in the app. The negotiated `pat_` token is delivered over the socket and
  persisted; it reconnects active on its own. Rotatable/revocable from the app.
- **Stateless execution.** The server holds the device credentials (encrypted at rest) and
  sends them **inline with each command**. The agent caches nothing about controllers.
- **Server-driven events.** The server periodically calls `getAccessEvents` through the
  agent to read each controller's event journal, deduping + storing centrally. The agent
  keeps no event state.
- Outbound WebSocket with reconnect (backoff + jitter) and heartbeat.
- Command handler with **per-controller serialization** (`queue.js`).
- Device layer = `src/hik` reused verbatim (digest auth, door-station XML, PINs…).
- Structured errors propagated back (`AGENT_OFFLINE`, `TIMEOUT`, `BAD_REQUEST`,
  `DEVICE_UNREACHABLE`, `DEVICE_REJECTED` + `deviceSub`).

## Config

`agent/config.json` (gitignored) — just the gateway URL:

```json
{ "gatewayUrl": "ws://localhost:4000/agent" }
```

The only local state is `agent/data/identity.json` (id + fingerprint + token), gitignored.
A manual `agentId`+`token` in `config.json` is still honored for legacy/pinned setups.

> Tuning note: the Gateway's RPC timeout should exceed the device ISAPI timeout (15s in
> `src/hik/isapi.js`), or unreachable devices surface as `TIMEOUT` instead of
> `DEVICE_UNREACHABLE`.

> Security: device credentials now traverse the agent↔gateway WebSocket per command, so
> run the gateway behind `wss://` in production.
