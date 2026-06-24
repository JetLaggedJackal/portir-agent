// ISUP (formerly EHome) adapter — SCAFFOLD.
//
// ISUP is Hikvision's device-initiated protocol: the controllers connect OUT to
// THIS server and register, so you can manage them even when they sit behind NAT
// with no public IP and no Hikvision cloud. That's the goal here.
//
// What this file does today (real, working):
//   - opens a TCP listener on ISUP_PORT so devices can connect to us
//   - tracks live connections in a registry the UI can display
//
// What it does NOT do yet (needs Hikvision's ISUP SDK + real hardware):
//   - parse the proprietary registration frames to learn each device's ISUP ID
//   - the session keep-alive / encryption handshake
//   - push person/card data and door commands over the session
//
// The ISUP wire protocol is binary and proprietary; the supported path is
// Hikvision's ISUP SDK (native libs). This scaffold gives you the server side and
// the integration seam (`pushPerson`, `openDoor`, …) so finishing it is a matter
// of dropping the SDK calls into the marked spots — the rest of Portir already
// treats ISUP controllers like any other.

import net from 'net';

class IsupRegistry {
  constructor() {
    this.connections = new Map(); // key -> { remoteAddress, remotePort, connectedAt, isupId, socket }
    this.server = null;
    this.port = null;
  }

  start(port) {
    if (this.server) return;
    this.port = port;
    this.server = net.createServer((socket) => {
      const key = `${socket.remoteAddress}:${socket.remotePort}`;
      const entry = {
        remoteAddress: socket.remoteAddress,
        remotePort: socket.remotePort,
        connectedAt: new Date().toISOString(),
        isupId: null, // filled once registration parsing is implemented (SDK)
        socket,
      };
      this.connections.set(key, entry);
      console.log(`[isup] device connected from ${key} (registration parsing requires the ISUP SDK)`);

      socket.on('data', (buf) => {
        // TODO(SDK): decode ISUP registration to set entry.isupId, then ACK.
        // Raw bytes are available here for whoever wires up the SDK/protocol.
        entry.lastBytes = buf.length;
        entry.lastSeen = new Date().toISOString();
      });
      socket.on('close', () => { this.connections.delete(key); });
      socket.on('error', () => { this.connections.delete(key); });
    });
    this.server.on('error', (e) => console.error('[isup] listener error:', e.message));
    this.server.listen(port, () => console.log(`[isup] listener on tcp/${port} — point controllers' ISUP/EHome platform here`));
  }

  // Public view for the UI: what's currently connected.
  status() {
    return [...this.connections.values()].map(({ socket, ...c }) => c);
  }

  // Look up a live session for a controller (by ISUP ID, once parsing exists).
  sessionFor(controller) {
    for (const c of this.connections.values()) {
      if (controller.isupId && c.isupId === controller.isupId) return c;
    }
    return null;
  }
}

export const isupRegistry = new IsupRegistry();

const NOT_READY =
  'ISUP transport is scaffolded but not yet active: it needs the Hikvision ISUP SDK ' +
  'to parse device registration and push data. The controller may be connected to the ' +
  'listener, but provisioning over ISUP is not implemented in this build. ' +
  'Use ISAPI (local/VPN) for now, or finish the ISUP SDK integration in src/hik/isup.js.';

export class IsupAdapter {
  constructor() { this.transport = 'isup'; }

  async listDoors(controller) {
    // We can't query an ISUP device without the SDK session, so trust the
    // door count the installer entered when registering the controller.
    const count = controller.doorCount || 1;
    return Array.from({ length: count }, (_, i) => ({
      doorNo: i + 1,
      name: count > 1 ? `${controller.name} – Door ${i + 1}` : controller.name,
    }));
  }

  async getStatus(controller) {
    // Without registration parsing we can't map a connection to this controller,
    // so report "unknown" unless a session is positively matched (needs SDK).
    const session = isupRegistry.sessionFor(controller);
    if (session) return { online: true };
    return { online: null, unknown: true };
  }

  async openDoor() { throw new Error(NOT_READY); }
  async pushPerson() { throw new Error(NOT_READY); }
  async removePerson() { throw new Error(NOT_READY); }
  async getAccessEvents() { return []; } // device events arrive over the ISUP session (needs SDK)
  async getPersons() { throw new Error(NOT_READY); } // reading users needs the ISUP SDK session
}
