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
    this.deviceStates = {
      temp: {},
      humidity: {},
    };
    this.lastMotionDetectedAt = 0;

    Service = api.hap.Service;
    Characteristic = api.hap.Characteristic;

    this.pollInterval = Math.max(Number(this.config.pollInterval || 120), 60);
    this.adaptivePolling = this.config.adaptivePolling || {};
    this.adaptivePollingEnabled = Boolean(this.adaptivePolling.enabled);
    this.activePollInterval = Math.max(Number(this.adaptivePolling.activePollInterval || 15), 10);
    this.motionHoldSeconds = Math.max(Number(this.adaptivePolling.motionHoldSeconds || 120), 30);

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

    if (this.adaptivePollingEnabled) {
      if (this.activePollInterval >= this.pollInterval) {
        this.log.error('adaptivePolling.activePollInterval must be less than pollInterval.');
        return false;
      }

      if (this.motionHoldSeconds < 30) {
        this.log.error('adaptivePolling.motionHoldSeconds must be 30 or greater.');
        return false;
      }
    }

    return true;
  }

  sanitizeLogMessage(message) {
    let result = String(message || 'Unknown error');
    const secrets = [this.config.userId, this.config.ssecurity, this.config.serviceToken].filter(Boolean);

    for (const secret of secrets) {
      result = result.split(String(secret)).join('[REDACTED]');
    }

    return result;
  }

  scheduleNextUpdate(nextPollInterval) {
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
    }

    this.updateTimer = setTimeout(() => {
      this.updateAll();
    }, nextPollInterval * 1000);
  }

  getNextPollInterval() {
    if (!this.adaptivePollingEnabled) {
      return this.pollInterval;
    }

    const motionActiveWindow =
      this.lastMotionDetectedAt > 0 &&
      Date.now() - this.lastMotionDetectedAt < this.motionHoldSeconds * 1000;

    return motionActiveWindow ? this.activePollInterval : this.pollInterval;
  }

  isMotionActive(raw) {
    if (raw === undefined || raw === null) {
      return false;
    }

    let value = raw;
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        value = Array.isArray(parsed) ? parsed[0] : parsed;
      } catch (_error) {
        value = raw;
      }
    }

    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'number') {
      return value > 0;
    }

    const text = String(value).trim().toLowerCase();
    if (['true', 'on', 'motion', 'active'].includes(text)) {
      return true;
    }

    if (['false', 'off', 'idle', 'inactive'].includes(text)) {
      return false;
    }

    if (/^[0-9]+$/.test(text)) {
      return Number(text) > 0;
    }

    if (/^[0-9a-f]+$/i.test(text)) {
      return parseInt(text, 16) > 0;
    }

    return false;
  }

  async getSensorMotionState(sensor) {
    const motionKey = sensor.motionKey || this.adaptivePolling.motionKey;
    if (!motionKey) {
      return false;
    }

    const motionDid = sensor.motionDid || sensor.did;
    const raw = await this.cloud.getRawValue(motionDid, String(motionKey));

    return this.isMotionActive(raw);
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
    let motionDetectedInCycle = false;

    try {
      for (const sensor of sensors) {
        try {
          const motionDetected = await this.updateSensor(sensor);
          motionDetectedInCycle = motionDetectedInCycle || motionDetected;
        } catch (error) {
          this.log.warn(`Update failed for ${sensor.name}: ${this.sanitizeLogMessage(error.message || error)}`);
        }
      }

      if (motionDetectedInCycle) {
        this.lastMotionDetectedAt = Date.now();
      }
    } finally {
      this.updateInProgress = false;
      this.scheduleNextUpdate(this.getNextPollInterval());
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

    if (!Number.isFinite(temperature) || !Number.isFinite(humidity)) {
      throw new Error(`Invalid numeric payload for ${sensor.name}`);
    }

    const stateId = sensor.did;
    if (this.deviceStates.temp[stateId] !== temperature) {
      tempService.updateCharacteristic(Characteristic.CurrentTemperature, temperature);
      this.deviceStates.temp[stateId] = temperature;
    }

    if (this.deviceStates.humidity[stateId] !== humidity) {
      humService.updateCharacteristic(Characteristic.CurrentRelativeHumidity, humidity);
      this.deviceStates.humidity[stateId] = humidity;
    }

    this.log.info(`${sensor.name}: ${temperature}°C / ${humidity}%`);

    if (!this.adaptivePollingEnabled) {
      return false;
    }

    try {
      return await this.getSensorMotionState(sensor);
    } catch (error) {
      this.log.debug(`Motion check failed for ${sensor.name}: ${this.sanitizeLogMessage(error.message || error)}`);
      return false;
    }
  }
}

module.exports = XiaomiHub2BLEPlatform;
