// Stable on-disk identity for a Site Agent.
//
// On first boot the agent mints a random id + a short human-readable fingerprint
// and persists them (plus the negotiated token, once approved) to
// agent/data/identity.json. This is what makes the agent self-enrolling: the same
// config.json (just gatewayUrl) can be shipped everywhere — each machine derives
// its own identity locally.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export class Identity {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.data = this._load();
    let changed = false;
    if (!this.data.agentId) { this.data.agentId = 'agt_' + crypto.randomUUID(); changed = true; }
    if (!this.data.fingerprint) { this.data.fingerprint = Identity._fingerprint(); changed = true; }
    if (changed) this._save();
  }

  static _fingerprint() {
    const hex = crypto.randomBytes(4).toString('hex').toUpperCase(); // 8 hex chars
    return `${hex.slice(0, 4)}-${hex.slice(4)}`;                     // e.g. AB12-CD34
  }

  _load() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return {}; } }
  _save() { const t = this.file + '.tmp'; fs.writeFileSync(t, JSON.stringify(this.data, null, 2)); fs.renameSync(t, this.file); }

  get agentId() { return this.data.agentId; }
  get fingerprint() { return this.data.fingerprint; }
  get token() { return this.data.token || null; }
  setToken(token) { this.data.token = token; this._save(); }
  clearToken() { delete this.data.token; this._save(); }
}
