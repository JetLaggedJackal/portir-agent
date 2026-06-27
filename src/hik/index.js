// Transport router. Each controller declares how it's reached (transport);
// this picks the right adapter per controller, so one site can mix
// local ISAPI controllers, cloud ones, ISUP ones, and mock demo ones.

import { MockAdapter } from './mock.js';
import { HppAdapter } from './hpp.js';
import { IsapiAdapter } from './isapi.js';
import { IsupAdapter, isupRegistry } from './isup.js';
import { RemoteAdapter } from './remote.js';

export function createHik(env) {
  const adapters = {
    mock: new MockAdapter(),
    isapi: new IsapiAdapter(),
    isup: new IsupAdapter(),
    cloud: null,  // built lazily below if credentials exist
    remote: null, // built if a gateway is configured
  };

  if (env.HIK_APP_KEY && env.HIK_SECRET_KEY) {
    adapters.cloud = new HppAdapter({
      baseUrl: env.HIK_BASE_URL,
      appKey: env.HIK_APP_KEY,
      secretKey: env.HIK_SECRET_KEY,
    });
  }

  // Remote transport: controllers reached via a site Agent through the gateway.
  if (env.GATEWAY_URL) {
    adapters.remote = new RemoteAdapter({ gatewayUrl: env.GATEWAY_URL, apiToken: env.GATEWAY_API_TOKEN });
  }

  // Start the ISUP listener so controllers can register to us.
  const isupEnabled = (env.HIK_MODE || '').toLowerCase().includes('isup') || env.ISUP_ENABLE === '1';
  if (isupEnabled) isupRegistry.start(Number(env.ISUP_PORT) || 7660);

  function adapterFor(controller) {
    const a = adapters[controller.transport];
    if (!a) {
      if (controller.transport === 'cloud') {
        throw new Error('Cloud controller, but HIK_APP_KEY / HIK_SECRET_KEY are not set in .env');
      }
      if (controller.transport === 'remote') {
        throw new Error('Remote controller, but GATEWAY_URL is not set in .env');
      }
      throw new Error(`Unknown transport "${controller.transport}" for controller ${controller.serial}`);
    }
    return a;
  }

  return {
    cloudEnabled: Boolean(adapters.cloud),
    remoteEnabled: Boolean(adapters.remote),
    gatewayUrl: env.GATEWAY_URL || null,
    isupEnabled,
    isupStatus: () => isupRegistry.status(),
    listDoors: (controller) => adapterFor(controller).listDoors(controller),
    openDoor: (controller, doorNo, meta) => adapterFor(controller).openDoor(controller, doorNo, meta),
    pushPerson: (controller, person, doorNos) => adapterFor(controller).pushPerson(controller, person, doorNos),
    removePerson: (controller, employeeNo) => adapterFor(controller).removePerson(controller, employeeNo),
    getAccessEvents: (controller, opts) => {
      const a = adapterFor(controller);
      return a.getAccessEvents ? a.getAccessEvents(controller, opts) : Promise.resolve([]);
    },
    getStatus: (controller) => {
      const a = adapterFor(controller);
      return a.getStatus ? a.getStatus(controller) : Promise.resolve({ online: null, unknown: true });
    },
    getDeviceInfo: (controller) => {
      const a = adapterFor(controller);
      return a.getDeviceInfo ? a.getDeviceInfo(controller) : Promise.resolve({ online: null, unsupported: true });
    },
    getPersons: (controller, opts) => {
      const a = adapterFor(controller);
      if (!a.getPersons) throw new Error(`Reading users is not supported for ${controller.transport} controllers`);
      return a.getPersons(controller, opts);
    },
    getFaces: (controller, opts) => {
      const a = adapterFor(controller);
      return a.getFaces ? a.getFaces(controller, opts) : Promise.resolve([]);
    },
    discoverCloudDevices: () => {
      if (!adapters.cloud) throw new Error('Cloud not configured (set HIK_APP_KEY / HIK_SECRET_KEY)');
      return adapters.cloud.discoverDevices();
    },
  };
}
