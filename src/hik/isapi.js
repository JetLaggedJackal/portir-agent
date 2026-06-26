// Direct ISAPI adapter — talks straight to a Hikvision access controller on the
// local network (or over a VPN) using HTTP Digest auth. No cloud, no API key.
//
// This is the same ISAPI person/door management the cloud transparent channel
// uses; here we send it directly to the device's IP. Intended for the case where
// the app is hosted on-site (or the server can reach the controllers via VPN).
//
// NOTE: requires network reachability to each controller. Not verified against
// live hardware in this build — the ISAPI payloads follow the documented schema
// and match what the cloud adapter sends. Failures log the full response.

import crypto from 'crypto';

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const TIMEOUT_MS = 15000;

// One request with Digest auth: try once, parse the 401 challenge, retry signed.
async function digestFetch(url, { method = 'GET', body, bodyFactory, username, password, contentType = 'application/json' }) {
  const u = new URL(url);
  const uri = u.pathname + u.search;
  // For multipart/streamed bodies pass contentType:null so fetch sets the
  // boundary itself; such bodies are single-use, so rebuild via bodyFactory.
  const headers = contentType ? { 'Content-Type': contentType } : {};
  const nextBody = () => (bodyFactory ? bodyFactory() : body);

  const first = await fetch(url, {
    method, headers, body: nextBody(), signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (first.status !== 401) return first;

  const challenge = first.headers.get('www-authenticate') || '';
  if (!/digest/i.test(challenge)) {
    // device wants Basic (rare, or anonymous off) — fall back to Basic
    const basic = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    return fetch(url, { method, headers: { ...headers, Authorization: basic }, body: nextBody(), signal: AbortSignal.timeout(TIMEOUT_MS) });
  }

  const p = Object.fromEntries(
    [...challenge.matchAll(/(\w+)="?([^",]+)"?/g)].map(m => [m[1].toLowerCase(), m[2]])
  );
  const realm = p.realm || '';
  const nonce = p.nonce || '';
  const qop = (p.qop || 'auth').split(',')[0].trim();
  const opaque = p.opaque;
  const cnonce = crypto.randomBytes(8).toString('hex');
  const nc = '00000001';

  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);

  let auth = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
  if (qop) auth += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  if (opaque) auth += `, opaque="${opaque}"`;

  return fetch(url, {
    method,
    headers: { ...headers, Authorization: auth },
    body: nextBody(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

export class IsapiAdapter {
  constructor() { this.transport = 'isapi'; }

  base(controller) {
    const scheme = controller.port === 443 ? 'https' : 'http';
    return `${scheme}://${controller.host}:${controller.port || 80}`;
  }

  async isapi(controller, isapiPath, payload, method = 'POST') {
    if (!controller.host) throw new Error(`Controller ${controller.serial} has no IP/host set`);
    const res = await digestFetch(`${this.base(controller)}${isapiPath}`, {
      method,
      body: payload ? JSON.stringify(payload) : undefined,
      username: controller.username,
      password: controller.password,
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    const status = data?.statusCode ?? data?.ResponseStatus?.statusCode;
    if (!res.ok || (status !== undefined && Number(status) !== 1)) {
      console.error(`[isapi] ${method} ${isapiPath} on ${controller.host} failed:`, res.status, text.slice(0, 1500));
      const reason = data?.subStatusCode || data?.errorMsg || data?.message || res.status;
      throw new Error(`Device ${controller.serial} rejected ${isapiPath}: ${reason}`);
    }
    return data;
  }

  // Reachability check: ask the device for its info over the network.
  async getStatus(controller) {
    try {
      const data = await this.isapi(controller, '/ISAPI/System/deviceInfo?format=json', null, 'GET');
      const di = data?.DeviceInfo || data || {};
      return { online: true, model: di.model, firmware: di.firmwareVersion, deviceName: di.deviceName };
    } catch (e) {
      return { online: false, error: e.message };
    }
  }

  // Pull a richer, read-only device profile for the controller-details view.
  // Each section is best-effort: a failing call records an error and the rest
  // still return.
  async getDeviceInfo(controller) {
    const info = { online: true, syncedAt: new Date().toISOString() };
    try {
      const di = (await this.isapi(controller, '/ISAPI/System/deviceInfo?format=json', null, 'GET'))?.DeviceInfo || {};
      Object.assign(info, {
        model: di.model, deviceName: di.deviceName, serial: di.serialNumber,
        firmware: di.firmwareVersion, firmwareReleased: di.firmwareReleasedDate,
        hardware: di.hardwareVersion, mac: di.macAddress, deviceType: di.deviceType, deviceID: di.deviceID,
      });
    } catch (e) { info.online = false; info.error = e.message; return info; }
    try {
      const net = await this.isapi(controller, '/ISAPI/System/Network/interfaces?format=json', null, 'GET');
      let ifaces = net?.NetworkInterfaceList?.NetworkInterface ?? net?.NetworkInterface ?? [];
      if (!Array.isArray(ifaces)) ifaces = [ifaces];
      info.network = ifaces.map(i => {
        const ip = i?.IPAddress || {};
        return { id: i?.id, address: ip.ipAddress, mask: ip.subnetMask, gateway: ip.DefaultGateway?.ipAddress, dns: ip.PrimaryDNS?.ipAddress, mac: i?.Link?.MACAddress };
      }).filter(x => x.address || x.mac);
    } catch { /* some firmwares restrict this */ }
    try {
      const time = (await this.isapi(controller, '/ISAPI/System/time?format=json', null, 'GET'))?.Time || {};
      info.timeZone = time.timeZone; info.localTime = time.localTime;
    } catch { /* optional */ }
    return info;
  }

  // Read users already programmed on the device (with their cards), so they can
  // be imported into Portir. Standard ISAPI search, paginated.
  async getPersons(controller, { pageSize = 30, guard = 200 } = {}) {
    const people = new Map(); // employeeNo -> person
    let pos = 0;
    for (let i = 0; i < guard; i++) {
      const data = await this.isapi(controller, '/ISAPI/AccessControl/UserInfo/Search?format=json', {
        UserInfoSearchCond: { searchID: crypto.randomUUID(), searchResultPosition: pos, maxResults: pageSize },
      }, 'POST');
      const s = data?.UserInfoSearch || {};
      const list = s.UserInfo || [];
      for (const u of list) {
        const empNo = String(u.employeeNo);
        people.set(empNo, {
          employeeNo: empNo,
          name: u.name || '',
          userType: u.userType || 'normal',
          validFrom: u.Valid?.enable ? (u.Valid.beginTime || null) : null,
          validTo: u.Valid?.enable ? (u.Valid.endTime || null) : null,
          pin: /^\d{4,8}$/.test(String(u.password || '')) ? String(u.password) : '',
          doorNos: parseDoorNos(u),
          cards: [],
        });
      }
      pos += list.length;
      const total = Number(s.totalMatches ?? s.numOfMatches ?? 0);
      if (!list.length || (total && pos >= total) || /NO MATCH/i.test(s.responseStatusStrg || '')) break;
    }

    // Attach cards by employeeNo.
    pos = 0;
    for (let i = 0; i < guard; i++) {
      let data;
      try {
        data = await this.isapi(controller, '/ISAPI/AccessControl/CardInfo/Search?format=json', {
          CardInfoSearchCond: { searchID: crypto.randomUUID(), searchResultPosition: pos, maxResults: pageSize },
        }, 'POST');
      } catch { break; } // some firmwares omit CardInfo search; users still import without cards
      const s = data?.CardInfoSearch || {};
      const list = s.CardInfo || [];
      for (const c of list) {
        const p = people.get(String(c.employeeNo));
        if (p && c.cardNo) p.cards.push(String(c.cardNo));
      }
      pos += list.length;
      const total = Number(s.totalMatches ?? s.numOfMatches ?? 0);
      if (!list.length || (total && pos >= total) || /NO MATCH/i.test(s.responseStatusStrg || '')) break;
    }
    return [...people.values()];
  }

  async listDoors(controller) {
    let count = controller.doorCount || 1;
    try {
      const cap = await this.isapi(controller, '/ISAPI/AccessControl/capabilities?format=json', null, 'GET');
      count = Number(cap?.AccessControlCap?.doorNum ?? cap?.doorNum ?? count) || count;
    } catch { /* fall back to configured doorCount */ }
    return Array.from({ length: count }, (_, i) => ({
      doorNo: i + 1,
      name: count > 1 ? `${controller.name} – Door ${i + 1}` : controller.name,
    }));
  }

  // Some device classes (notably KD-series video-intercom DOOR STATIONS) are
  // XML-native and reject the JSON form of control commands with
  // "invalidOperation", even though they accept JSON for UserInfo. XML is
  // accepted by access-control panels too, so we send the door command as XML.
  async isapiXml(controller, isapiPath, xml, method = 'PUT') {
    if (!controller.host) throw new Error(`Controller ${controller.serial} has no IP/host set`);
    const res = await digestFetch(`${this.base(controller)}${isapiPath}`, {
      method, body: xml, contentType: 'application/xml',
      username: controller.username, password: controller.password,
    });
    const text = await res.text();
    const sub = (text.match(/<subStatusCode>([^<]+)<\/subStatusCode>/i) || [])[1] || '';
    const statusStr = (text.match(/<statusString>([^<]+)<\/statusString>/i) || [])[1] || '';
    const ok = res.ok && (statusStr.toUpperCase() === 'OK' || sub.toLowerCase() === 'ok' || (!sub && !statusStr));
    if (!ok) {
      console.error(`[isapi] ${method} ${isapiPath} (xml) on ${controller.host} failed:`, res.status, text.slice(0, 1000));
      throw new Error(`Device ${controller.serial} rejected ${isapiPath}: ${sub || statusStr || res.status}`);
    }
    return text;
  }

  async openDoor(controller, doorNo) {
    await this.isapiXml(
      controller,
      `/ISAPI/AccessControl/RemoteControl/door/${doorNo}`,
      `<RemoteControlDoor version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><cmd>open</cmd></RemoteControlDoor>`,
      'PUT'
    );
    return { ok: true };
  }

  async pushPerson(controller, person, doorNos) {
    const userInfo = {
      UserInfo: {
        employeeNo: String(person.employeeNo),
        name: person.name,
        userType: person.type === 'visitor' ? 'visitor' : 'normal',
        // Always enable the validity window (a wide default for permanent
        // people) — some devices treat enable:false as "inactive".
        Valid: {
          enable: true,
          beginTime: toIsapiTime(person.validFrom, '2000-01-01T00:00:00'),
          endTime: toIsapiTime(person.validTo, '2037-12-31T23:59:59'),
        },
        doorRight: doorNos.join(','),
        RightPlan: doorNos.map(n => ({ doorNo: n, planTemplateNo: '1' })),
      },
    };
    if (person.pin) userInfo.UserInfo.password = String(person.pin);

    try {
      await this.isapi(controller, '/ISAPI/AccessControl/UserInfo/Record?format=json', userInfo, 'POST');
    } catch (e) {
      if (/employeeNoAlreadyExist|deviceUserAlreadyExist/i.test(e.message)) {
        await this.isapi(controller, '/ISAPI/AccessControl/UserInfo/Modify?format=json', userInfo, 'PUT');
      } else throw e;
    }

    // Cards: push every card on the person (multi-card support). Back-compat with
    // the legacy single cardNo when `cards` is absent.
    const cards = (Array.isArray(person.cards) && person.cards.length) ? person.cards : (person.cardNo ? [person.cardNo] : []);
    for (const cardNo of cards) {
      const cardInfo = { CardInfo: { employeeNo: String(person.employeeNo), cardNo: String(cardNo), cardType: 'normalCard' } };
      try {
        await this.isapi(controller, '/ISAPI/AccessControl/CardInfo/Record?format=json', cardInfo, 'POST');
      } catch (e) {
        if (!/cardNoAlreadyExist|cardAlreadyExist/i.test(e.message)) throw e;
      }
    }

    // Face: best-effort enrollment to the device's face library. Failure does NOT
    // block card/PIN provisioning (the person still gets in). Not verified against
    // live hardware — payload follows the documented ISAPI FDLib schema.
    if (person.faceImage?.data) {
      try { await this.pushFace(controller, person); }
      catch (e) { console.error(`[isapi] face enroll failed for ${person.employeeNo} on ${controller.host}: ${e.message}`); }
    }
    return { ok: true };
  }

  // Enroll a face photo via FDLib. Multipart: a JSON FaceDataRecord part + the
  // image. Digest auth needs the body sent twice (challenge + signed), so the
  // multipart body is rebuilt per attempt. NOT verified on hardware.
  async pushFace(controller, person) {
    if (!controller.host) throw new Error(`Controller ${controller.serial} has no IP/host set`);
    const buf = Buffer.from(person.faceImage.data, 'base64');
    const type = person.faceImage.contentType || 'image/jpeg';
    const url = `${this.base(controller)}/ISAPI/Intelligent/FDLib/FaceDataRecord?format=json`;
    const makeBody = () => {
      const fd = new FormData();
      fd.append('FaceDataRecord', JSON.stringify({ faceLibType: 'blackFD', FDID: String(controller.faceFDID || '1'), FPID: String(person.employeeNo) }));
      fd.append('img', new Blob([buf], { type }), 'face.jpg');
      return fd;
    };
    const res = await digestFetch(url, { method: 'POST', body: makeBody(), bodyFactory: makeBody, username: controller.username, password: controller.password, contentType: null });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    const status = data?.statusCode ?? data?.ResponseStatus?.statusCode;
    if (!res.ok || (status !== undefined && Number(status) !== 1)) {
      throw new Error(`face record rejected: ${data?.subStatusCode || data?.errorMsg || res.status}`);
    }
    return { ok: true };
  }

  async removePerson(controller, employeeNo) {
    await this.isapi(
      controller,
      '/ISAPI/AccessControl/UserInfo/Delete?format=json',
      { UserInfoDelCond: { EmployeeNoList: [{ employeeNo: String(employeeNo) }] } },
      'PUT'
    );
    return { ok: true };
  }

  // Query the controller's access-event journal (badge-ins). Standard ISAPI
  // AcsEvent search; returns normalized entries. Not verified against live
  // hardware — field names follow the documented AcsEvent schema.
  async getAccessEvents(controller, { doorNo, days = 7, max = 50 } = {}) {
    const end = new Date();
    const start = new Date(end.getTime() - days * 86400000);
    const body = {
      AcsEventCond: {
        searchID: crypto.randomUUID(),
        searchResultPosition: 0,
        maxResults: max,
        major: 5, minor: 0, // 5 = access-control event group
        startTime: start.toISOString().slice(0, 19),
        endTime: end.toISOString().slice(0, 19),
        ...(doorNo ? { doorNo } : {}),
      },
    };
    const data = await this.isapi(controller, '/ISAPI/AccessControl/AcsEvent?format=json', body, 'POST');
    const list = data?.AcsEvent?.InfoList || data?.InfoList || [];
    return list.map(e => ({
      ts: e.time || e.dateTime || null,
      personName: e.name || e.employeeNoString || '',
      employeeNo: e.employeeNoString || e.employeeNo || '',
      doorNo: e.doorNo ?? doorNo ?? null,
      status: /fail|denied|reject/i.test(JSON.stringify(e.subEventType || e.eventType || '')) ? 'denied' : 'granted',
      method: e.cardReaderKind || e.attendanceStatus || 'card',
    }));
  }
}

function toIsapiTime(value, fallback) {
  if (!value) return fallback;
  const s = String(value);
  return s.length === 16 ? `${s}:00` : s;
}

// Which door numbers a device user has rights to (from RightPlan or doorRight).
function parseDoorNos(u) {
  const nos = new Set();
  if (Array.isArray(u.RightPlan)) for (const r of u.RightPlan) { const n = Number(r.doorNo); if (n) nos.add(n); }
  if (u.doorRight) String(u.doorRight).split(',').forEach(x => { const n = Number(x); if (n) nos.add(n); });
  return [...nos];
}
