// Mock adapter — lets the whole app run with no Hikvision hardware or credentials.
// Controllers with transport 'mock' are simulated in memory.

const delay = (ms) => new Promise(r => setTimeout(r, ms));

export class MockAdapter {
  constructor() {
    this.transport = 'mock';
    this.deviceUsers = new Map(); // serial -> Map(employeeNo -> payload)
    this.accessLog = new Map();   // 'serial:doorNo' -> [event]
  }

  async getStatus(controller) {
    await delay(200);
    return { online: true, model: controller.deviceModel || 'DS-K (demo)', firmware: 'V1.0.0 build mock' };
  }

  async getDeviceInfo(controller) {
    await delay(250);
    return {
      online: true, syncedAt: new Date().toISOString(),
      model: controller.deviceModel || 'DS-K1T343 (demo)', deviceName: controller.name || 'Demo controller',
      serial: 'DS-MOCK-' + (controller.serial || '0000'), firmware: 'V1.0.0 build mock', firmwareReleased: '210101',
      hardware: '0x1', mac: '00:11:22:33:44:55', deviceType: 'AccessControl',
      network: [{ id: 1, address: '192.168.1.64', mask: '255.255.255.0', gateway: '192.168.1.1', dns: '8.8.8.8', mac: '00:11:22:33:44:55' }],
      timeZone: 'CST-1:00:00', localTime: new Date().toISOString(),
      userCount: 12, cardCount: 18, tamper: 'normal', battery: 'normal',
      doorStatus: [{ doorNo: 1, door: 'close', lock: 'lock' }],
      doorParams: [{ doorNo: 1, name: 'Demo door', openDuration: 5, openTimeout: 30 }],
    };
  }

  // Pretend the controller already had a couple of users programmed before Portir.
  async getPersons(controller) {
    await delay(350);
    const tag = (controller.serial.replace(/\D/g, '').slice(-3) || '000');
    return [
      { employeeNo: `${tag}01`, name: 'Ivan Horvat', userType: 'normal', cards: [`1000${tag}1`], pin: '', doorNos: [1], validFrom: null, validTo: null },
      { employeeNo: `${tag}02`, name: 'Marija Novak', userType: 'normal', cards: [`1000${tag}2`], pin: '5731', doorNos: [1], validFrom: null, validTo: null },
    ];
  }

  async listDoors(controller) {
    await delay(150);
    const count = controller.doorCount || 1;
    return Array.from({ length: count }, (_, i) => ({
      doorNo: i + 1,
      name: count > 1 ? `${controller.name} – Door ${i + 1}` : controller.name,
    }));
  }

  async openDoor(controller, doorNo, meta = {}) {
    await delay(350);
    console.log(`[mock] open door ${controller.serial} #${doorNo}`);
    this.logRemoteOpen(controller, doorNo, meta.actorName);
    return { ok: true };
  }

  async pushPerson(controller, person, doorNos) {
    await delay(400);
    const serial = controller.serial;
    if (!this.deviceUsers.has(serial)) this.deviceUsers.set(serial, new Map());
    this.deviceUsers.get(serial).set(person.employeeNo, { ...person, doorNos });
    console.log(`[mock] pushed ${person.name} (${person.employeeNo}) to ${serial} doors ${doorNos.join(',')}`);
    return { ok: true };
  }

  async removePerson(controller, employeeNo) {
    await delay(250);
    this.deviceUsers.get(controller.serial)?.delete(employeeNo);
    console.log(`[mock] removed employeeNo ${employeeNo} from ${controller.serial}`);
    return { ok: true };
  }

  // Record a real remote-open so it shows up in the simulated access log.
  logRemoteOpen(controller, doorNo, actorName) {
    const key = `${controller.serial}:${doorNo}`;
    if (!this.accessLog.has(key)) this.accessLog.set(key, []);
    this.accessLog.get(key).push({
      ts: new Date().toISOString(), personName: actorName || 'Remote (app)',
      employeeNo: '', doorNo, status: 'granted', method: 'remote',
    });
  }

  // Simulated badge-in history for a door. Generated once per door and cached so
  // it's stable across calls; seeded from the people the caller passes in.
  async getAccessEvents(controller, { doorNo, people = [] } = {}) {
    await delay(120);
    const key = `${controller.serial}:${doorNo}`;
    if (!this.accessLog.has(key)) {
      this.accessLog.set(key, this._seedAccessLog(key, doorNo, people));
    }
    return [...this.accessLog.get(key)].sort((a, b) => b.ts.localeCompare(a.ts));
  }

  _seedAccessLog(key, doorNo, people) {
    // tiny deterministic PRNG seeded from the door key
    let seed = [...key].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const methods = ['card', 'pin', 'face'];
    const pool = people.length ? people : [{ name: 'Unknown card', employeeNo: '' }];
    const out = [];
    const n = 6 + Math.floor(rnd() * 10);
    for (let i = 0; i < n; i++) {
      const who = pool[Math.floor(rnd() * pool.length)];
      const ago = Math.floor(rnd() * 72 * 60); // minutes within last 3 days
      const ts = new Date(Date.now() - ago * 60000).toISOString();
      const denied = rnd() < 0.15;
      out.push({
        ts, personName: who.name, employeeNo: who.employeeNo || '',
        doorNo, status: denied ? 'denied' : 'granted',
        method: methods[Math.floor(rnd() * methods.length)],
      });
    }
    return out;
  }
}
