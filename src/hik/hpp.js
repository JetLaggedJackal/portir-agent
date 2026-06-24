// Hik-Partner Pro OpenAPI adapter.
//
// Works against devices that are added to your Hik-Partner Pro (Hik-Connect
// installer) account. You need an API Key + Secret from the Hik-Partner Pro
// portal (Support -> OpenAPI / contact your Hikvision rep).
//
// NOTE: endpoint paths and field names below follow the Hik-Partner Pro
// OpenAPI Developer Guide (v2.x, /api/hpcgw/...). Hikvision revises this guide
// regularly and some fields differ per region/version — if a call fails, the
// full request/response is logged so you can align it with the PDF guide that
// comes with your API key. Person provisioning to the controllers is done via
// the documented ISAPI-transparent channel, which is stable across versions.

import crypto from 'crypto';

const ISAPI_TIMEOUT_MS = 30000;

export class HppAdapter {
  constructor({ baseUrl, appKey, secretKey }) {
    this.transport = 'cloud';
    this.baseUrl = (baseUrl || 'https://api.hik-partner.com').replace(/\/+$/, '');
    this.appKey = appKey;
    this.secretKey = secretKey;
    this.token = null;
    this.tokenExpires = 0;
  }

  async getToken() {
    if (this.token && Date.now() < this.tokenExpires - 60000) return this.token;
    const res = await fetch(`${this.baseUrl}/api/hpcgw/v2/token/get`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appKey: this.appKey, secretKey: this.secretKey }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !(data?.data?.access_token || data?.data?.accessToken)) {
      console.error('[hpp] token/get failed:', res.status, JSON.stringify(data));
      throw new Error(`Hik-Partner Pro auth failed (${data?.errorCode || res.status}): ${data?.message || 'check HIK_APP_KEY / HIK_SECRET_KEY'}`);
    }
    this.token = data.data.access_token || data.data.accessToken;
    // expires_in is seconds; areaDomain (if returned) is the regional gateway we must use from now on.
    const expiresIn = Number(data.data.expires_in || data.data.expiresIn || 3600);
    this.tokenExpires = Date.now() + expiresIn * 1000;
    if (data.data.areaDomain) this.baseUrl = String(data.data.areaDomain).replace(/\/+$/, '');
    return this.token;
  }

  async call(path, body = {}, method = 'POST') {
    const token = await this.getToken();
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Token': token, // some gateway versions expect this header instead
      },
      body: method === 'GET' ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    const code = data?.errorCode ?? data?.code;
    if (!res.ok || (code !== undefined && String(code) !== '0' && String(code) !== '200')) {
      console.error(`[hpp] ${method} ${path} failed:`, res.status, JSON.stringify(data).slice(0, 2000));
      throw new Error(`Hikvision API error on ${path}: ${data?.message || data?.msg || res.status}`);
    }
    return data;
  }

  // Transparent ISAPI channel to a specific device. This is how persons/cards
  // are written into the access controller itself.
  async isapi(deviceSerial, isapiPath, payload, method = 'POST') {
    const token = await this.getToken();
    const url = `${this.baseUrl}/api/hpcgw/v1/device/transparent${isapiPath}`;
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Token': token,
        'EZO-DeviceSerial': deviceSerial,
        'deviceSerial': deviceSerial,
      },
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(ISAPI_TIMEOUT_MS),
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    const status = data?.statusCode ?? data?.ResponseStatus?.statusCode;
    if (!res.ok || (status !== undefined && Number(status) !== 1)) {
      console.error(`[hpp] ISAPI ${method} ${isapiPath} on ${deviceSerial} failed:`, res.status, text.slice(0, 2000));
      throw new Error(`Device ${deviceSerial} rejected ${isapiPath}: ${data?.subStatusCode || data?.errorMsg || data?.message || res.status}`);
    }
    return data;
  }

  // ---- adapter interface ----

  // Cloud-sync helper: list every access-control device on the account so the
  // installer can import them as controllers (one building per site name).
  async discoverDevices() {
    const data = await this.call('/api/hpcgw/v1/device/list', { pageIndex: 1, pageSize: 200 });
    const devices = data?.data?.list || data?.data?.devices || data?.data || [];
    const out = [];
    for (const dev of devices) {
      const serial = dev.deviceSerial || dev.serialNo || dev.deviceSerialNo;
      const category = (dev.deviceCategory || dev.category || dev.deviceType || '').toLowerCase();
      if (category && !/acs|access|door|axpro|control/i.test(category) && !/^ds-k/i.test(dev.deviceModel || dev.model || '')) continue;
      out.push({
        serial,
        deviceModel: dev.deviceModel || dev.model || '',
        siteName: dev.siteName || dev.site || 'Cloud site',
        deviceName: dev.deviceName || serial,
        doorCount: await this.getDoorCount(serial).catch(() => 1),
      });
    }
    return out;
  }

  async getDoorCount(deviceSerial) {
    const data = await this.isapi(deviceSerial, '/ISAPI/AccessControl/capabilities?format=json', null, 'GET');
    return Number(data?.AccessControlCap?.doorNum ?? data?.doorNum ?? 1) || 1;
  }

  async listDoors(controller) {
    const count = await this.getDoorCount(controller.serial).catch(() => controller.doorCount || 1);
    return Array.from({ length: count }, (_, i) => ({
      doorNo: i + 1,
      name: count > 1 ? `${controller.name} – Door ${i + 1}` : controller.name,
    }));
  }

  async openDoor(controller, doorNo) {
    await this.isapi(
      controller.serial,
      `/ISAPI/AccessControl/RemoteControl/door/${doorNo}?format=json`,
      { RemoteControlDoor: { cmd: 'open' } },
      'PUT'
    );
    return { ok: true };
  }

  // Write/overwrite a person (and their card/PIN) on one controller, granting
  // the listed door numbers on that controller. Uses standard ISAPI person
  // management (UserInfo / CardInfo), supported by DS-K26xx, DS-K1T3xx etc.
  async pushPerson(controller, person, doorNos) {
    const deviceSerial = controller.serial;
    const userInfo = {
      UserInfo: {
        employeeNo: String(person.employeeNo),
        name: person.name,
        userType: person.type === 'visitor' ? 'visitor' : 'normal',
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

    // Create, or modify if the employeeNo already exists on the device.
    try {
      await this.isapi(deviceSerial, '/ISAPI/AccessControl/UserInfo/Record?format=json', userInfo, 'POST');
    } catch (e) {
      if (/employeeNoAlreadyExist|deviceUserAlreadyExist/i.test(e.message)) {
        await this.isapi(deviceSerial, '/ISAPI/AccessControl/UserInfo/Modify?format=json', userInfo, 'PUT');
      } else {
        throw e;
      }
    }

    if (person.cardNo) {
      const cardInfo = {
        CardInfo: {
          employeeNo: String(person.employeeNo),
          cardNo: String(person.cardNo),
          cardType: 'normalCard',
        },
      };
      try {
        await this.isapi(deviceSerial, '/ISAPI/AccessControl/CardInfo/Record?format=json', cardInfo, 'POST');
      } catch (e) {
        if (!/cardNoAlreadyExist|cardAlreadyExist/i.test(e.message)) throw e;
      }
    }
    return { ok: true };
  }

  async removePerson(controller, employeeNo) {
    await this.isapi(
      controller.serial,
      '/ISAPI/AccessControl/UserInfo/Delete?format=json',
      { UserInfoDelCond: { EmployeeNoList: [{ employeeNo: String(employeeNo) }] } },
      'PUT'
    );
    return { ok: true };
  }

  async getStatus(controller) {
    try {
      const data = await this.isapi(controller.serial, '/ISAPI/System/deviceInfo?format=json', null, 'GET');
      const di = data?.DeviceInfo || data || {};
      return { online: true, model: di.model, firmware: di.firmwareVersion, deviceName: di.deviceName };
    } catch (e) {
      return { online: false, error: e.message };
    }
  }

  async getPersons(controller, { pageSize = 30, guard = 200 } = {}) {
    const serial = controller.serial;
    const people = new Map();
    let pos = 0;
    for (let i = 0; i < guard; i++) {
      const data = await this.isapi(serial, '/ISAPI/AccessControl/UserInfo/Search?format=json', {
        UserInfoSearchCond: { searchID: crypto.randomUUID(), searchResultPosition: pos, maxResults: pageSize },
      }, 'POST');
      const s = data?.UserInfoSearch || {};
      const list = s.UserInfo || [];
      for (const u of list) {
        const nos = new Set();
        if (Array.isArray(u.RightPlan)) for (const r of u.RightPlan) { const n = Number(r.doorNo); if (n) nos.add(n); }
        if (u.doorRight) String(u.doorRight).split(',').forEach(x => { const n = Number(x); if (n) nos.add(n); });
        people.set(String(u.employeeNo), {
          employeeNo: String(u.employeeNo), name: u.name || '', userType: u.userType || 'normal',
          validFrom: u.Valid?.enable ? (u.Valid.beginTime || null) : null,
          validTo: u.Valid?.enable ? (u.Valid.endTime || null) : null,
          pin: /^\d{4,8}$/.test(String(u.password || '')) ? String(u.password) : '',
          doorNos: [...nos], cards: [],
        });
      }
      pos += list.length;
      const total = Number(s.totalMatches ?? s.numOfMatches ?? 0);
      if (!list.length || (total && pos >= total) || /NO MATCH/i.test(s.responseStatusStrg || '')) break;
    }
    pos = 0;
    for (let i = 0; i < guard; i++) {
      let data;
      try {
        data = await this.isapi(serial, '/ISAPI/AccessControl/CardInfo/Search?format=json', {
          CardInfoSearchCond: { searchID: crypto.randomUUID(), searchResultPosition: pos, maxResults: pageSize },
        }, 'POST');
      } catch { break; }
      const s = data?.CardInfoSearch || {};
      const list = s.CardInfo || [];
      for (const c of list) { const p = people.get(String(c.employeeNo)); if (p && c.cardNo) p.cards.push(String(c.cardNo)); }
      pos += list.length;
      const total = Number(s.totalMatches ?? s.numOfMatches ?? 0);
      if (!list.length || (total && pos >= total) || /NO MATCH/i.test(s.responseStatusStrg || '')) break;
    }
    return [...people.values()];
  }

  async getAccessEvents(controller, { doorNo, days = 7, max = 50 } = {}) {
    const end = new Date();
    const start = new Date(end.getTime() - days * 86400000);
    const body = {
      AcsEventCond: {
        searchID: crypto.randomUUID(), searchResultPosition: 0, maxResults: max,
        major: 5, minor: 0,
        startTime: start.toISOString().slice(0, 19), endTime: end.toISOString().slice(0, 19),
        ...(doorNo ? { doorNo } : {}),
      },
    };
    const data = await this.isapi(controller.serial, '/ISAPI/AccessControl/AcsEvent?format=json', body, 'POST');
    const list = data?.AcsEvent?.InfoList || data?.InfoList || [];
    return list.map(e => ({
      ts: e.time || e.dateTime || null,
      personName: e.name || e.employeeNoString || '',
      employeeNo: e.employeeNoString || e.employeeNo || '',
      doorNo: e.doorNo ?? doorNo ?? null,
      status: /fail|denied|reject/i.test(JSON.stringify(e.subEventType || e.eventType || '')) ? 'denied' : 'granted',
      method: e.cardReaderKind || 'card',
    }));
  }
}

function toIsapiTime(value, fallback) {
  if (!value) return fallback;
  // 'YYYY-MM-DDTHH:mm' from <input type=datetime-local> -> 'YYYY-MM-DDTHH:mm:ss'
  const s = String(value);
  return s.length === 16 ? `${s}:00` : s;
}
