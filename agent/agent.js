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
import dgram from 'dgram';
import crypto from 'crypto';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';
import { createHik } from '../src/hik/index.js';
import { Queues } from './queue.js';
import { Identity } from './identity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_VERSION = '2.9.3'; // 2.9.3: broaden PIN detection + capability field diagnostic
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

// ---- self-update: pull the latest agent code + restart (systemd brings it back) ----
// A FIXED routine — git pull + npm install against the agent's own checkout. It runs
// no caller-supplied commands, so the server can only trigger an update, never run
// arbitrary code. Requires a git checkout + a supervisor that restarts on exit
// (e.g. systemd Restart=always); a manual `node agent/agent.js` won't auto-restart.
const REPO_ROOT = path.join(__dirname, '..');
const sh = (cmd) => new Promise((resolve) => exec(cmd, { cwd: REPO_ROOT, timeout: 120000, windowsHide: true },
  (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, out: String(stdout || '').trim(), err: String(stderr || '').trim() })));

// Preferred update path: the server pushes the agent's own files down the live
// connection and we write + restart. Only agent/*.{js,json} and src/hik/*.js are
// accepted (no path traversal, no touching config.json/identity). Needs a supervisor
// that restarts on exit (systemd Restart=always) — no git or internet required.
const ALLOWED_UPDATE = /^(agent\/[\w.-]+\.(?:js|json)|src\/hik\/[\w.-]+\.js)$/;
async function applyUpdate({ files = [], version } = {}) {
  if (!Array.isArray(files) || !files.length) return { updated: false, reason: 'no-files', message: 'No files in update' };
  for (const f of files) {
    if (!f || typeof f.path !== 'string' || typeof f.content !== 'string') return { updated: false, reason: 'bad-file', message: 'Malformed file entry' };
    if (f.path.includes('..') || path.isAbsolute(f.path) || !ALLOWED_UPDATE.test(f.path)) return { updated: false, reason: 'bad-path', message: `Rejected path ${f.path}` };
    if (f.path === 'agent/config.json') return { updated: false, reason: 'bad-path', message: 'Refusing to overwrite config.json' };
  }
  for (const f of files) {
    const dest = path.join(REPO_ROOT, f.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${Date.now()}`;
    fs.writeFileSync(tmp, f.content);
    fs.renameSync(tmp, dest); // atomic replace
  }
  setTimeout(() => { console.log(`[agent] applied ${files.length} pushed file(s) → restarting`); process.exit(0); }, 1500);
  return { updated: true, files: files.length, version: version || AGENT_VERSION, restarting: true, message: `Applied ${files.length} file(s) from server; restarting` };
}

async function updateAgent() {
  if (!fs.existsSync(path.join(REPO_ROOT, '.git'))) {
    return { updated: false, reason: 'not-git', message: 'Agent is not a git checkout — update it manually.' };
  }
  const before = (await sh('git rev-parse --short HEAD')).out;
  const pull = await sh('git pull --ff-only');
  if (pull.code !== 0) return { updated: false, reason: 'pull-failed', before, message: (pull.err || pull.out).slice(0, 400) };
  const after = (await sh('git rev-parse --short HEAD')).out;
  if (after === before) return { updated: false, reason: 'up-to-date', before, after, message: `Already up to date (${after})` };
  const npm = await sh('npm install --omit=dev --no-audit --no-fund');
  // Reply first, then exit so the supervisor restarts us with the new code.
  setTimeout(() => { console.log(`[agent] updated ${before} → ${after}, restarting`); process.exit(0); }, 1500);
  return { updated: true, before, after, restarting: true, version: AGENT_VERSION, npmOk: npm.code === 0,
           message: `Updated ${before} → ${after}; restarting${npm.code === 0 ? '' : ' (npm install reported an issue)'}` };
}

// ---- command execution: run the wire method against the inline device payload ----
// ---- SADP: discover Hikvision devices on the local network ----
// Hikvision's Search Active Devices Protocol: a UDP multicast inquiry on
// 239.255.255.250:37020; devices answer with an XML ProbeMatch carrying their
// IP/serial/model/MAC/firmware. We send a few probes (UDP is lossy) and collect
// replies for a few seconds. Multicast must be permitted on the LAN.
const SADP_MCAST = '239.255.255.250';
const SADP_PORT = 37020;
const xmlVal = (xml, tag) => { const m = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i').exec(xml || ''); return m ? m[1].trim() : undefined; };

function scanNetwork({ timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const found = new Map();
    let sock;
    const finish = (extra = {}) => { try { sock?.close(); } catch { /* closed */ } resolve({ devices: [...found.values()], count: found.size, ...extra }); };
    try { sock = dgram.createSocket({ type: 'udp4', reuseAddr: true }); }
    catch (e) { return resolve({ devices: [], error: e.message }); }
    sock.on('error', (e) => finish({ error: e.message }));
    sock.on('message', (msg) => {
      const xml = msg.toString('utf8');
      if (!/ProbeMatch|DeviceSN|DeviceDescription/i.test(xml)) return; // ignore our own probe / noise
      const dev = {
        ip: xmlVal(xml, 'IPv4Address'), serial: xmlVal(xml, 'DeviceSN'),
        model: xmlVal(xml, 'DeviceDescription'), mac: xmlVal(xml, 'MAC'),
        firmware: xmlVal(xml, 'SoftwareVersion') || xmlVal(xml, 'DeviceSoftwareVersion'),
        mask: xmlVal(xml, 'IPv4SubnetMask'), gateway: xmlVal(xml, 'IPv4Gateway'),
        httpPort: xmlVal(xml, 'HttpPort'), deviceType: xmlVal(xml, 'DeviceType'),
        activated: xmlVal(xml, 'Activated'),
      };
      const key = dev.serial || dev.mac || dev.ip;
      if (key && (dev.ip || dev.serial)) found.set(key, dev);
    });
    sock.bind(SADP_PORT, () => {
      try { sock.addMembership(SADP_MCAST); } catch { /* membership can fail; replies may still arrive */ }
      try { sock.setBroadcast(true); sock.setMulticastTTL(8); } catch { /* ok */ }
      const probe = Buffer.from(`<?xml version="1.0" encoding="utf-8"?>\r\n<Probe><Uuid>${crypto.randomUUID()}</Uuid><Types>inquiry</Types></Probe>\r\n`, 'utf8');
      const send = () => { try { sock.send(probe, 0, probe.length, SADP_PORT, SADP_MCAST); } catch { /* ignore */ } };
      send(); setTimeout(send, 400); setTimeout(send, 1200);
    });
    setTimeout(() => finish(), timeoutMs);
  });
}

async function execute(cmd) {
  if (cmd.method === 'applyUpdate') return applyUpdate(cmd.args); // server-pushed files
  if (cmd.method === 'updateAgent') return updateAgent();         // legacy git self-update
  if (cmd.method === 'scanNetwork') return scanNetwork(cmd.args || {}); // SADP LAN discovery
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
    case 'getFaces':        return hik.getFaces(ctl, a);
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
