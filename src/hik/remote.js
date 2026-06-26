// Remote transport — the server side of the split architecture.
//
// The server holds the controller's coordinates + credentials (encrypted at
// rest, decrypted in memory). This adapter implements the SAME interface as the
// local adapters but ships each call — together with the device connection
// details inline — to the gateway, which routes it to the owning Agent
// (controller.agentId). The Agent is a stateless relay: it executes against the
// device payload in the command and keeps nothing locally. See
// docs/GATEWAY-CONTRACT.md.

// The device payload sent to the Agent. On the site LAN a `remote` controller is
// reached directly over ISAPI, so map the routing transport accordingly.
function deviceFor(c) {
  return {
    id: c.id,
    transport: c.transport === 'remote' ? 'isapi' : c.transport,
    host: c.host, port: c.port,
    username: c.username, password: c.password || '',
    doorCount: c.doorCount,
  };
}

const DEVICE_TIMEOUT_MS = 20000; // > src/hik/isapi.js device timeout (15s) so an
                                 // unreachable device surfaces as DEVICE_UNREACHABLE,
                                 // not a premature gateway TIMEOUT.

export class RemoteAdapter {
  constructor({ gatewayUrl, apiToken } = {}) {
    this.transport = 'remote';
    this.gatewayUrl = (gatewayUrl || 'http://localhost:4000').replace(/\/+$/, '');
    this.apiToken = apiToken || '';
  }

  async _invoke(controller, method, args, { timeoutMs = DEVICE_TIMEOUT_MS } = {}) {
    if (!controller.agentId) throw new Error('Remote controller has no agentId');
    const headers = { 'Content-Type': 'application/json' };
    if (this.apiToken) headers['x-gw-token'] = this.apiToken;
    const res = await fetch(`${this.gatewayUrl}/gw/invoke`, {
      method: 'POST', headers,
      body: JSON.stringify({ agentId: controller.agentId, method, controllerId: controller.id, device: deviceFor(controller), args, timeoutMs }),
      signal: AbortSignal.timeout(timeoutMs + 3000),
    });
    return res.json().catch(() => ({ ok: false, error: { code: 'GATEWAY_ERROR', message: `gateway HTTP ${res.status}` } }));
  }

  // ---- RPC (online-only) ----
  async _rpc(controller, method, args) {
    const r = await this._invoke(controller, method, args);
    if (!r.ok) throw new Error(r.error?.message || 'gateway error');
    return r.data;
  }
  listDoors(c) { return this._rpc(c, 'listDoors', {}); }
  openDoor(c, doorNo, meta = {}) { return this._rpc(c, 'openDoor', { doorNo, actorName: meta.actorName }); }
  getPersons(c, opts = {}) { return this._rpc(c, 'getPersons', opts); }
  getFaces(c, opts = {}) { return this._rpc(c, 'getFaces', opts); }
  getAccessEvents(c, opts = {}) { return this._rpc(c, 'getAccessEvents', opts); }
  // getStatus never throws — mirror the local adapters' behavior.
  async getStatus(c) {
    try { return await this._rpc(c, 'getStatus', {}); }
    catch (e) { return { online: false, error: e.message }; }
  }
  // getDeviceInfo never throws — surface unreachability as { online:false }.
  async getDeviceInfo(c) {
    try { return await this._rpc(c, 'getDeviceInfo', {}); }
    catch (e) { return { online: false, error: e.message }; }
  }

  // ---- Sync (durable): apply now if the Agent is online, else mark pending ----
  async pushPerson(c, person, doorNos) { return this._sync(c, 'pushPerson', { person, doorNos }); }
  async removePerson(c, employeeNo) { return this._sync(c, 'removePerson', { employeeNo }); }
  async _sync(c, method, args) {
    const r = await this._invoke(c, method, args);
    if (r.ok) return r.data;
    if (r.error?.code === 'AGENT_OFFLINE') return { pending: true }; // reconciler retries
    throw new Error(r.error?.message || 'gateway error');
  }
}
