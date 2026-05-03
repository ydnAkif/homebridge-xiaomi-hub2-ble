const XiaomiCloud = require('./xiaomiCloud');

const PLUGIN_NAME = 'homebridge-xiaomi-hub2-ble';
const PLATFORM_NAME = 'XiaomiHub2BLE';

let Service;
let Characteristic;

class XiaomiHub2BLEPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessories = new Map();
    this.updateInProgress = false;
    this.updateTimer = null;

    Service = api.hap.Service;
    Characteristic = api.hap.Characteristic;

    this.pollInterval = Math.max(Number(this.config.pollInterval || 120), 60);

    this.cloud = new XiaomiCloud({
      country: this.config.country || 'tw',
      userId: this.config.userId,
      ssecurity: this.config.ssecurity,
      serviceToken: this.config.serviceToken,
      requestTimeout: this.config.requestTimeout,
      requestRetries: this.config.requestRetries,
      retryDelay: this.config.retryDelay,
      log: this.log,
    });

    this.api.on('didFinishLaunching', () => {
      this.log.info('Xiaomi Hub 2 BLE platform started 🚀');

      if (!this.validateConfig()) {
        this.log.error('Platform startup aborted due to invalid config.');
        return;
      }

      this.registerSensors();
      this.updateAll();

      this.updateTimer = setInterval(() => {
        this.updateAll();
      }, this.pollInterval * 1000);
    });
  }

  validateConfig() {
    if (!this.config.userId || !this.config.ssecurity || !this.config.serviceToken) {
      this.log.error('Missing Xiaomi Cloud auth config: userId, ssecurity or serviceToken.');
      return false;
    }

    if (!Array.isArray(this.config.sensors) || this.config.sensors.length === 0) {
      this.log.warn('No sensors configured.');
      return false;
    }

    if (this.config.requestTimeout !== undefined && Number(this.config.requestTimeout) <= 0) {
      this.log.error('requestTimeout must be greater than 0.');
      return false;
    }

    if (this.config.requestRetries !== undefined && Number(this.config.requestRetries) < 0) {
      this.log.error('requestRetries must be 0 or greater.');
      return false;
    }

    if (this.config.retryDelay !== undefined && Number(this.config.retryDelay) < 0) {
      this.log.error('retryDelay must be 0 or greater.');
      return false;
    }

    return true;
  }

  configureAccessory(accessory) {
    this.accessories.set(accessory.UUID, accessory);
  }

  registerSensors() {
    const sensors = this.config.sensors || [];
    const configuredUuids = new Set();

    for (const sensor of sensors) {
      if (!sensor.name || !sensor.did) {
        this.log.warn('Skipping invalid sensor config:', JSON.stringify(sensor));
        continue;
      }

      const uuid = this.api.hap.uuid.generate(sensor.did);
      configuredUuids.add(uuid);
      let accessory = this.accessories.get(uuid);

      if (!accessory) {
        accessory = new this.api.platformAccessory(sensor.name, uuid);
        accessory.context.did = sensor.did;
        accessory.context.name = sensor.name;

        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.set(uuid, accessory);

        this.log.info(`Registered sensor: ${sensor.name}`);
      } else {
        accessory.context.did = sensor.did;
        accessory.context.name = sensor.name;
        accessory.displayName = sensor.name;

        this.log.info(`Loaded cached sensor: ${sensor.name}`);
      }

      this.ensureServices(accessory, sensor);
    }

    const staleAccessories = [];
    for (const [uuid, accessory] of this.accessories.entries()) {
      if (!configuredUuids.has(uuid)) {
        staleAccessories.push(accessory);
      }
    }

    if (staleAccessories.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, staleAccessories);
      for (const accessory of staleAccessories) {
        this.accessories.delete(accessory.UUID);
      }
      this.log.info(`Unregistered ${staleAccessories.length} removed sensor accessory(s).`);
    }
  }

  ensureServices(accessory, sensor) {
    accessory
      .getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Xiaomi')
      .setCharacteristic(Characteristic.Model, sensor.model || 'miaomiaoce.sensor_ht.t2')
      .setCharacteristic(Characteristic.SerialNumber, sensor.did);

    let tempService = accessory.getService(Service.TemperatureSensor);
    if (!tempService) {
      tempService = accessory.addService(Service.TemperatureSensor, `${sensor.name} Temperature`, 'temperature');
    }

    let humService = accessory.getService(Service.HumiditySensor);
    if (!humService) {
      humService = accessory.addService(Service.HumiditySensor, `${sensor.name} Humidity`, 'humidity');
    }

    tempService
      .getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({
        minValue: -50,
        maxValue: 100,
        minStep: 0.1,
      });

    humService
      .getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .setProps({
        minValue: 0,
        maxValue: 100,
        minStep: 0.1,
      });
  }

  async updateAll() {
    if (this.updateInProgress) {
      this.log.debug('Skipping update cycle because previous cycle is still running.');
      return;
    }

    this.updateInProgress = true;
    const sensors = this.config.sensors || [];

    try {
      for (const sensor of sensors) {
        try {
          await this.updateSensor(sensor);
        } catch (error) {
          this.log.warn(`Update failed for ${sensor.name}: ${error.message || error}`);
        }
      }
    } finally {
      this.updateInProgress = false;
    }
  }

  async updateSensor(sensor) {
    const uuid = this.api.hap.uuid.generate(sensor.did);
    const accessory = this.accessories.get(uuid);

    if (!accessory) {
      return;
    }

    const tempService = accessory.getService(Service.TemperatureSensor);
    const humService = accessory.getService(Service.HumiditySensor);

    const [temperature, humidity] = await Promise.all([
      this.cloud.getTemperature(sensor.did),
      this.cloud.getHumidity(sensor.did),
    ]);

    tempService.updateCharacteristic(Characteristic.CurrentTemperature, temperature);
    humService.updateCharacteristic(Characteristic.CurrentRelativeHumidity, humidity);

    this.log.info(`${sensor.name}: ${temperature}°C / ${humidity}%`);
  }
}

module.exports = XiaomiHub2BLEPlatform;
