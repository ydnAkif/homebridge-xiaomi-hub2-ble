const test = require('node:test');
const assert = require('node:assert/strict');
const XiaomiHub2BLEPlatform = require('../src/platform');

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
    }

    setCharacteristic(characteristic, value) {
      this.updatedValues.set(characteristic, value);
      return this;
    }

    getCharacteristic(characteristic) {
      if (!this.characteristics.has(characteristic)) {
        const store = { props: null };
        this.characteristics.set(characteristic, {
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
    }
  }

  const hap = {
    Service: {
      AccessoryInformation: 'AccessoryInformation',
      TemperatureSensor: 'TemperatureSensor',
      HumiditySensor: 'HumiditySensor',
    },
    Characteristic: {
      Manufacturer: 'Manufacturer',
      Model: 'Model',
      SerialNumber: 'SerialNumber',
      CurrentTemperature: 'CurrentTemperature',
      CurrentRelativeHumidity: 'CurrentRelativeHumidity',
    },
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
