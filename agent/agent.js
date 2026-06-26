// Portir Site Agent — a stateless local relay.
//
// Runs at the customer site. Keeps one outbound WebSocket to the Gateway and
// executes commands against the local devices using Portir's existing src/hik
// device layer — unchanged. It holds NO controller or people data: every command
// carries the target device's connection details inline (`cmd.device`), and access
// events are pulled by the server through this agent (it just answers
// `getAccessEvents`). The only thing persisted locally is the agent's own identity
// (agent/data/identity.json) so it can reconnect authenticated.
//
// Zero-touch enrollment: ship the same config.json (just { gatewayUrl }) to every
// site. On first boot the agent mints its own identity (agent/identity.js) and
// connects with NO token → it shows up as `pending` in the app. An installer
// approves it; the server pushes the negotiated token down the socket; the agent
// persists it and reconnects authenticated. A manual config (agentId + token) is
// still honored for backward compatibility.

import 'dotenv/config';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';
import { createHik } from '../src/hik/index.js';
import { Queues } from './queue.js';
import { Identity } from './identity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_VERSION = '2.1.0'; // 2.1: system telemetry + getDeviceInfo
const HEARTBEAT_MS = 20000;

const cfgPath = process.env.AGENT_CONFIG || path.join(__dirname, 'config.json');
let config;
try {
  config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
} catch (e) {
  console.error(`[agent] cannot read config at ${cfgPath}. Copy config.example.json → config.json.`);
  process.exit(1);
}
if (!config.gatewayUrl) { console.error('[agent] config.gatewayUrl is required'); process.exit(1); }

const identity = new Identity(path.join(__dirname, 'data', 'identity.json'));
// A manual config still wins (legacy / pinned agents); otherwise use the local identity.
const AGENT_ID = (config.agentId || identity.agentId).trim();
const FINGERPRINT = identity.fingerprint;
const HOSTNAME = os.hostname();
const currentToken = () => config.token || identity.token; // recomputed each connect

const hik = createHik(process.env);              // device adapters, reused as-is
const queues = new Queues();                     // per-controller serialization

// ---- command execution: run the wire method against the inline device payload ----
async function execute(cmd) {
  const ctl = cmd.device;
  if (!ctl || !ctl.transport) throw withCode(new Error('command is missing its device payload'), 'BAD_REQUEST');
  const a = cmd.args || {};
  switch (cmd.method) {
    case 'getStatus':       return hik.getStatus(ctl);
    case 'getDeviceInfo':   return hik.getDeviceInfo(ctl);
    case 'listDoors':       return hik.listDoors(ctl);
    case 'openDoor':        return hik.openDoor(ctl, a.doorNo, { actorName: a.actorName });
    case 'pushPerson':      return hik.pushPerson(ctl, a.person, a.doorNos);
    case 'removePerson':    return hik.removePerson(ctl, a.employeeNo);
    case 'getPersons':      return hik.getPersons(ctl, a);
    case 'getAccessEvents': return hik.getAccessEvents(ctl, a);
    default: throw withCode(new Error(`unknown method ${cmd.method}`), 'BAD_REQUEST');
  }
}

function withCode(err, code) { err.code = code; return err; }
function classify(e) {
  if (e.code) return e.code;
  if (/no IP\/host|fetch failed|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|getaddrinfo|aborted|timeout/i.test(e.message)) return 'DEVICE_UNREACHABLE';
  if (/rejected/i.test(e.message)) return 'DEVICE_REJECTED';
  return 'DEVICE_ERROR';
}
const subOf = (e) => { const m = /:\s*([A-Za-z][\w]*)\s*$/.exec(e.message || ''); return m ? m[1] : undefined; };

// ---- agent telemetry (reported to the server for the agent-details view) ----
const SYSTEM_REFRESH_MS = Number(process.env.SYSTEM_REFRESH_MS) || 300000;
function localIPs() {
  const out = [];
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) out.push({ iface, address: a.address, mac: a.mac, cidr: a.cidr });
  }
  return out;
}
async function publicIp() {
  if (process.env.AGENT_NO_PUBLIC_IP === '1') return null; // opt out of the outbound lookup
  try { const r = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(5000) }); return r.ok ? (await r.text()).trim() : null; }
  catch { return null; }
}
const quickSystem = () => ({
  hostname: HOSTNAME, platform: os.platform(), release: os.release(), arch: os.arch(),
  nodeVersion: process.version, agentVersion: AGENT_VERSION,
  uptime: Math.round(os.uptime()), totalMem: os.totalmem(), localIPs: localIPs(), at: new Date().toISOString(),
});
const systemInfo = async () => ({ ...quickSystem(), publicIp: await publicIp() });

// ---- connection manager ----
let ws = null;
let backoff = 1000;
let heartbeat = null;
let systemTimer = null;
let enrolling = false;   // true while connected without a token (awaiting approval)

function connect() {
  const token = currentToken();
  enrolling = !token;
  if (token) {
    console.log(`[agent] connecting to ${config.gatewayUrl} as ${AGENT_ID} …`);
    ws = new WebSocket(config.gatewayUrl, { headers: { authorization: `Bearer ${token}`, 'x-agent-id': AGENT_ID } });
  } else {
    console.log(`[agent] connecting to ${config.gatewayUrl} to enroll (fingerprint ${FINGERPRINT}) …`);
    ws = new WebSocket(config.gatewayUrl); // no auth header → enrollment path
  }

  ws.on('open', () => {
    backoff = 1000;
    if (enrolling) {
      console.log(`[agent] connected — requesting approval. In the app, approve agent "${HOSTNAME}" with fingerprint ${FINGERPRINT}.`);
      send({ type: 'enroll', agentId: AGENT_ID, fingerprint: FINGERPRINT, hostname: HOSTNAME, version: AGENT_VERSION, system: quickSystem() });
    } else {
      console.log('[agent] connected');
      send({ type: 'hello', version: AGENT_VERSION, system: quickSystem() });
    }
    heartbeat = setInterval(() => send({ type: 'ping' }), HEARTBEAT_MS);
    // Push full telemetry (incl. public IP, which needs an async lookup) shortly
    // after connecting, then refresh periodically.
    const pushSystem = async () => send({ type: 'system', system: await systemInfo() });
    pushSystem();
    systemTimer = setInterval(pushSystem, SYSTEM_REFRESH_MS);
  });

  ws.on('message', onMessage);

  ws.on('close', (code) => {
    clearInterval(heartbeat); clearInterval(systemTimer);
    if (code === 4003) console.log('[agent] enrollment was rejected; will keep retrying — reject it permanently in the app to stop it');
    else console.log(`[agent] disconnected (${code}); reconnecting`);
    scheduleReconnect();
  });

  ws.on('error', (e) => console.error('[agent] ws error:', e.message));
}

function scheduleReconnect() {
  const delay = Math.min(backoff, 30000) + Math.floor(Math.random() * 500);
  setTimeout(connect, delay);
  backoff = Math.min(backoff * 2, 30000);
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

async function onMessage(raw) {
  let cmd; try { cmd = JSON.parse(raw); } catch { return; }
  if (cmd.type === 'pong') return;

  // ---- enrollment lifecycle ----
  if (cmd.type === 'enroll-status') {
    if (cmd.status === 'pending') console.log(`[agent] pending approval — fingerprint ${FINGERPRINT}`);
    return;
  }
  if (cmd.type === 'enrolled' && cmd.token) {
    identity.setToken(cmd.token);
    console.log('[agent] approved ✓ — token received, reconnecting as an active agent');
    try { ws.close(); } catch {} // reconnect picks up the new token (active path)
    return;
  }
  if (cmd.type === 'rejected') { console.log('[agent] enrollment rejected by an admin'); return; }

  // ---- commands ----
  if (cmd.type !== 'cmd') return;
  if (enrolling) return; // ignore commands until approved

  // serialize per controller so concurrent ops don't race on one device
  queues.run(cmd.controllerId || '_', async () => {
    let res;
    try {
      const data = await execute(cmd);
      res = { v: 1, type: 'res', correlationId: cmd.id, ok: true, data };
    } catch (e) {
      res = { v: 1, type: 'res', correlationId: cmd.id, ok: false,
              error: { code: classify(e), message: e.message, deviceSub: subOf(e) } };
      console.error(`[agent] ${cmd.method} on ${cmd.controllerId} failed: ${e.message}`);
    }
    send(res);
  });
}

console.log(`[agent] Portir agent v${AGENT_VERSION} — id ${AGENT_ID} (stateless relay)`);
if (!currentToken()) console.log(`[agent] not yet enrolled — fingerprint ${FINGERPRINT}`);
connect();

process.on('SIGINT', () => { try { ws?.close(); } catch {} process.exit(0); });
