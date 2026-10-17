const test = require('node:test');
const assert = require('node:assert/strict');
const XiaomiHub2BLEPlatform = require('../src/platform');

function batteryFixture() {
  const sensor = { name: 'Kitchen', did: '123' };
  const f = createPlatformFixture({ sensors: [sensor] });
  f.platform.registerSensors();
  f.sensor = sensor;
  f.accessory = f.platform.accessories.get('uuid:123');
  f.setBattery = (level, ageHours = 0) => {
    f.platform.batteryNextPoll.delete(sensor.did);
    f.platform.cloud.getBattery = async () => level;
    f.platform.cloud.readingTimes.set('123:4106', Date.now() - ageHours * 3600000);
  };
  return f;
}

test('battery service reports low battery below 20, recovers and polls only hourly', async () => {
  const f = batteryFixture();
  const warnings = [];
  f.platform.log.warn = message => warnings.push(message);
  const service = f.accessory.getService(f.api.hap.Service.Battery);
  for (const level of [100, 20, 19, 10, 0, 100, 10]) {
    f.setBattery(level);
    await f.platform.updateBattery(f.sensor, f.accessory);
    assert.equal(service.updatedValues.get('BatteryLevel'), level);
    assert.equal(service.updatedValues.get('StatusLowBattery'), level < 20 ? 1 : 0);
    assert.equal(service.getCharacteristic('BatteryLevel').getter(), level);
  }
  assert.equal(warnings.length, 2); // One per low-battery episode, including after recovery.
  f.platform.cloud.getBattery = async () => { throw Error('should not poll twice'); };
  await f.platform.updateBattery(f.sensor, f.accessory);
  assert.equal(warnings.length, 2);
  assert.equal(service.updatedValues.get('ChargingState'), 2);
});

test('battery is unknown before first report and stale cached percentages are not served', async () => {
  const f = batteryFixture();
  const unavailable = e => e.hapStatus === -70402;
  assert.throws(() => f.platform.getBatteryLevel('123'), unavailable);
  f.setBattery(50, 12);
  await f.platform.updateBattery(f.sensor, f.accessory);
  assert.equal(f.platform.getBatteryLevel('123'), 50);
  f.platform.batteryReadings.get('123').measuredAt = Date.now() - 49 * 3600000;
  assert.throws(() => f.platform.getBatteryLevel('123'), unavailable);
  f.setBattery(100, 49);
  await f.platform.updateBattery(f.sensor, f.accessory);
  assert.throws(() => f.platform.getBatteryLevel('123'), unavailable);
});

test('battery failures leave measurements working, deduplicate warnings and propagate expired auth', async () => {
  const f = batteryFixture();
  const warnings = [];
  f.platform.log.warn = message => warnings.push(message);
  f.platform.cloud.getTemperature = async () => 22;
  f.platform.cloud.getHumidity = async () => 60;
  f.platform.cloud.readingTimes.set('123:4100', Date.now());
  f.platform.cloud.readingTimes.set('123:4102', Date.now());
  f.platform.cloud.getBattery = async () => { throw Error('No battery report'); };
  await f.platform.updateSensor(f.sensor);
  f.platform.batteryNextPoll.delete('123');
  await f.platform.updateSensor(f.sensor);
  assert.equal(warnings.length, 1);
  assert.equal(f.accessory.getService('TemperatureSensor').updatedValues.get('CurrentTemperature'), 22);
  f.platform.batteryNextPoll.delete('123');
  f.platform.cloud.getBattery = async () => { throw Object.assign(Error('renew login'), { code: 'XIAOMI_AUTH_REQUIRED' }); };
  await assert.rejects(f.platform.updateSensor(f.sensor), { code: 'XIAOMI_AUTH_REQUIRED' });
});

test('battery data restored from accessory context survives restart without overwriting a later report', async () => {
  const f = batteryFixture();
  f.setBattery(10, 1);
  await f.platform.updateBattery(f.sensor, f.accessory);
  f.platform.batteryReadings.clear();
  f.platform.ensureServices(f.accessory, f.sensor);
  assert.equal(f.platform.getBatteryLevel('123'), 10);
});

function createPlatformFixture(config = {}) {
  const registered = [];
  const unregistered = [];
  const eventHandlers = new Map();

  class FakeService {
    constructor(type, name, subtype) {
      this.type = type;
      this.name = name;
      this.subtype = subtype;
      this.characteristics = new Map();
      this.updatedValues = new Map();
      this.updateCalls = new Map();
    }

    setCharacteristic(characteristic, value) {
      this.updatedValues.set(characteristic, value);
      return this;
    }

    getCharacteristic(characteristic) {
      if (!this.characteristics.has(characteristic)) {
        const store = { props: null };
        this.characteristics.set(characteristic, {
          onGet(handler) { this.getter = handler; return this; },
          setProps(props) {
            store.props = props;
            return this;
          },
          store,
        });
      }

      return this.characteristics.get(characteristic);
    }

    updateCharacteristic(characteristic, value) {
      this.updatedValues.set(characteristic, value);
      this.updateCalls.set(characteristic, (this.updateCalls.get(characteristic) || 0) + 1);
    }
  }

  const hap = {
    Service: {
      AccessoryInformation: 'AccessoryInformation',
      TemperatureSensor: 'TemperatureSensor',
      HumiditySensor: 'HumiditySensor',
      Battery: 'Battery',
    },
    Characteristic: {
      Manufacturer: 'Manufacturer',
      Model: 'Model',
      SerialNumber: 'SerialNumber',
      CurrentTemperature: 'CurrentTemperature',
      CurrentRelativeHumidity: 'CurrentRelativeHumidity',
      StatusFault: 'StatusFault',
      BatteryLevel: 'BatteryLevel', StatusLowBattery: 'StatusLowBattery', ChargingState: 'ChargingState',
    },
    HapStatusError: class extends Error { constructor(status) { super(String(status)); this.hapStatus = status; } },
    HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 },
    uuid: {
      generate(value) {
        return `uuid:${value}`;
      },
    },
  };

  class FakePlatformAccessory {
    constructor(name, uuid) {
      this.displayName = name;
      this.UUID = uuid;
      this.context = {};
      this.services = new Map([
        [hap.Service.AccessoryInformation, new FakeService(hap.Service.AccessoryInformation, 'Accessory Information')],
      ]);
    }

    getService(type) {
      return this.services.get(type);
    }

    addService(type, name, subtype) {
      const service = new FakeService(type, name, subtype);
      this.services.set(type, service);
      return service;
    }
  }

  const api = {
    hap,
    platformAccessory: FakePlatformAccessory,
    on(event, handler) {
      eventHandlers.set(event, handler);
    },
    registerPlatformAccessories(pluginName, platformName, accessories) {
      registered.push({ pluginName, platformName, accessories });
    },
    unregisterPlatformAccessories(pluginName, platformName, accessories) {
      unregistered.push({ pluginName, platformName, accessories });
    },
  };

  const log = {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };

  const platform = new XiaomiHub2BLEPlatform(log, config, api);
  platform.cloud.getBattery = async () => { throw new Error("No battery fixture data"); };

  return {
    api,
    eventHandlers,
    platform,
    registered,
    unregistered,
  };
}

test('validateConfig returns false when credentials are missing', () => {
  const { platform } = createPlatformFixture({ sensors: [{ name: 'Bedroom', did: '123' }] });

  assert.equal(platform.validateConfig(), false);
});

test('registerSensors unregisters stale cached accessories', () => {
  const fixture = createPlatformFixture({
    userId: 'user-id',
    ssecurity: 'AA==',
    serviceToken: 'service-token',
    sensors: [{ name: 'Bedroom', did: '123' }],
  });

  const staleAccessory = new fixture.api.platformAccessory('Old Sensor', 'uuid:old');
  fixture.platform.configureAccessory(staleAccessory);

  fixture.platform.registerSensors();

  assert.equal(fixture.registered.length, 1);
  assert.equal(fixture.unregistered.length, 1);
  assert.equal(fixture.unregistered[0].accessories[0].UUID, 'uuid:old');
});

test('updateAll skips when an update cycle is already running', async () => {
  const { platform } = createPlatformFixture({
    userId: 'user-id',
    ssecurity: 'AA==',
    serviceToken: 'service-token',
    sensors: [{ name: 'Bedroom', did: '123' }],
  });

  let updateCalls = 0;
  platform.updateSensor = async () => {
    updateCalls += 1;
  };
  platform.updateInProgress = true;

  await platform.updateAll();

  assert.equal(updateCalls, 0);
});

test('validateConfig rejects invalid adaptive polling intervals', () => {
  const { platform } = createPlatformFixture({
    userId: 'user-id',
    ssecurity: 'AA==',
    serviceToken: 'service-token',
    pollInterval: 120,
    adaptivePolling: {
      enabled: true,
      activePollInterval: 120,
    },
    sensors: [{ name: 'Bedroom', did: '123' }],
  });

  assert.equal(platform.validateConfig(), false);
});

test('updateSensor sends characteristic updates only on state delta', async () => {
  const fixture = createPlatformFixture({
    userId: 'user-id',
    ssecurity: 'AA==',
    serviceToken: 'service-token',
    sensors: [{ name: 'Bedroom', did: '123' }],
  });

  fixture.platform.registerSensors();

  fixture.platform.cloud.getTemperature = async () => 22.5;
  fixture.platform.cloud.getHumidity = async () => 50.1;
  fixture.platform.cloud.readingTimes.set('123:4100', Date.now());
  fixture.platform.cloud.readingTimes.set('123:4102', Date.now());

  await fixture.platform.updateSensor({ name: 'Bedroom', did: '123' });
  await fixture.platform.updateSensor({ name: 'Bedroom', did: '123' });

  const accessory = fixture.platform.accessories.get('uuid:123');
  const tempService = accessory.getService(fixture.api.hap.Service.TemperatureSensor);
  const humService = accessory.getService(fixture.api.hap.Service.HumiditySensor);

  assert.equal(tempService.updateCalls.get(fixture.api.hap.Characteristic.CurrentTemperature), 1);
  assert.equal(humService.updateCalls.get(fixture.api.hap.Characteristic.CurrentRelativeHumidity), 1);

  fixture.platform.cloud.getTemperature = async () => 23.5;
  fixture.platform.cloud.getHumidity = async () => 50.1;

  await fixture.platform.updateSensor({ name: 'Bedroom', did: '123' });

  assert.equal(tempService.updateCalls.get(fixture.api.hap.Characteristic.CurrentTemperature), 2);
  assert.equal(humService.updateCalls.get(fixture.api.hap.Characteristic.CurrentRelativeHumidity), 1);
});

test('expired session stops the cycle and faults every sensor without rescheduling', async () => {
  const sensors = [{ name: 'One', did: '1' }, { name: 'Two', did: '2' }];
  const { platform, api } = createPlatformFixture({ sensors });
  platform.registerSensors();
  let requests = 0, logs = 0;
  platform.log.error = () => logs++;
  platform.updateSensor = async () => { requests++; throw Object.assign(new Error('Renew login'), { code: 'XIAOMI_AUTH_REQUIRED' }); };
  await platform.updateAll();
  await platform.updateAll();
  assert.equal(requests, 1);
  assert.equal(logs, 1);
  assert.equal(platform.updateTimer, null);
  for (const accessory of platform.accessories.values()) {
    assert.equal(accessory.getService(api.hap.Service.TemperatureSensor).updatedValues.get('StatusFault'), 1);
  }
});

test('stale cloud measurements are rejected and fresh readings clear the fault', async () => {
  const sensor = { name: 'One', did: '1' };
  const { platform, api } = createPlatformFixture({ sensors: [sensor] });
  platform.registerSensors();
  platform.cloud.getTemperature = async () => 20;
  platform.cloud.getHumidity = async () => 50;
  platform.cloud.readingTimes.set('1:4100', Date.now() - 3600000);
  platform.cloud.readingTimes.set('1:4102', Date.now() - 3600000);
  await assert.rejects(platform.updateSensor(sensor), /stale/);
  const service = platform.accessories.get('uuid:1').getService(api.hap.Service.TemperatureSensor);
  assert.equal(service.updatedValues.get('StatusFault'), 1);
  assert.equal(service.updatedValues.has('CurrentTemperature'), false);
  platform.cloud.readingTimes.set('1:4102', Date.now());
  await platform.updateSensor(sensor);
  assert.equal(service.updatedValues.get('StatusFault'), 0);
  assert.equal(service.updatedValues.get('CurrentTemperature'), 20);
});

test('repeated outages log once and back off, then recover', async () => {
  const { platform } = createPlatformFixture({ sensors: [{ name: 'One', did: '1' }] });
  let logs = 0, interval;
  platform.log.warn = () => logs++;
  platform.scheduleNextUpdate = value => { interval = value; };
  platform.updateSensor = async () => { throw new Error('Network unavailable'); };
  await platform.updateAll();
  assert.equal(interval, 240);
  await platform.updateAll();
  assert.equal(interval, 480);
  assert.equal(logs, 1);
  platform.updateSensor = async () => false;
  await platform.updateAll();
  assert.equal(interval, 120);
});

test('shutdown during a request prevents new timers and further sensor requests', async () => {
  const { platform, eventHandlers } = createPlatformFixture({ sensors: [{ name: 'One', did: '1' }, { name: 'Two', did: '2' }] });
  let requests = 0;
  platform.updateSensor = async () => { requests++; eventHandlers.get('shutdown')(); };
  await platform.updateAll();
  assert.equal(requests, 1);
  assert.equal(platform.updateTimer, null);
});
test('validateConfig rejects invalid numeric options', () => {
  const { platform } = createPlatformFixture({
    userId: 'user-id',
    ssecurity: 'AA==',
    serviceToken: 'service-token',
    pollInterval: 'not-a-number',
    sensors: [{ name: 'Bedroom', did: '123' }],
  });

  assert.equal(platform.validateConfig(), false);
});
test('validateConfig rejects duplicate sensor DIDs', () => {
  const { platform } = createPlatformFixture({
    userId: 'user-id',
    ssecurity: 'AA==',
    serviceToken: 'service-token',
    sensors: [
      { name: 'Bedroom', did: '123' },
      { name: 'Hallway', did: '123' },
    ],
  });

  assert.equal(platform.validateConfig(), false);
});
test('shutdown clears the pending update timer', () => {
  const { eventHandlers, platform } = createPlatformFixture({
    userId: 'user-id',
    ssecurity: 'AA==',
    serviceToken: 'service-token',
    sensors: [{ name: 'Bedroom', did: '123' }],
  });

  platform.updateTimer = setTimeout(() => {}, 60000);
  eventHandlers.get('shutdown')();

  assert.equal(platform.updateTimer, null);
});
