const XiaomiCloud = require('./xiaomiCloud');

const PLUGIN_NAME = 'homebridge-xiaomi-hub2-ble';
const PLATFORM_NAME = 'XiaomiHub2BLE';

let Service;
let Characteristic;

function finiteNumberOrDefault(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

class XiaomiHub2BLEPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessories = new Map();
    this.updateInProgress = false;
    this.updateTimer = null;
    this.stopped = false;
    this.authBlocked = false;
    this.failureCycles = 0;
    this.sensorErrors = new Map();
    this.lastSuccess = new Map();
    this.staleAfterSeconds = Math.max(finiteNumberOrDefault(this.config.staleAfterSeconds, 1800), 300);
    this.deviceStates = {
      temp: {},
      humidity: {},
    };
    this.lastMotionDetectedAt = 0;

    Service = api.hap.Service;
    Characteristic = api.hap.Characteristic;

    this.pollInterval = Math.max(finiteNumberOrDefault(this.config.pollInterval, 120), 60);
    this.adaptivePolling =
      this.config.adaptivePolling && typeof this.config.adaptivePolling === 'object'
        ? this.config.adaptivePolling
        : {};
    this.adaptivePollingEnabled = Boolean(this.adaptivePolling.enabled);
    this.activePollInterval = Math.max(
      finiteNumberOrDefault(this.adaptivePolling.activePollInterval, 15),
      10,
    );
    this.motionHoldSeconds = Math.max(
      finiteNumberOrDefault(this.adaptivePolling.motionHoldSeconds, 120),
      30,
    );

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

    this.api.on('shutdown', () => {
      this.stopped = true;
      if (this.updateTimer) {
        clearTimeout(this.updateTimer);
        this.updateTimer = null;
      }
    });
  }

  validateNumberOption(name, value, { min, max, integer = false }) {
    if (value === undefined) {
      return true;
    }

    const parsed = Number(value);
    if (
      !Number.isFinite(parsed) ||
      parsed < min ||
      parsed > max ||
      (integer && !Number.isInteger(parsed))
    ) {
      const valueType = integer ? 'an integer' : 'a numeric';
      this.log.error(`${name} must be ${valueType} value between ${min} and ${max}.`);
      return false;
    }

    return true;
  }

  validateConfig() {
    if (!this.validateNumberOption('staleAfterSeconds', this.config.staleAfterSeconds, { min: 300, max: 86400, integer: true })) return false;
    if (!this.config.userId || !this.config.ssecurity || !this.config.serviceToken) {
      this.log.error('Missing Xiaomi Cloud auth config: userId, ssecurity or serviceToken.');
      return false;
    }

    if (!Array.isArray(this.config.sensors) || this.config.sensors.length === 0) {
      this.log.warn('No sensors configured.');
      return false;
    }

    if (!this.validateNumberOption('pollInterval', this.config.pollInterval, {
      min: 60,
      max: 86400,
      integer: true,
    })) {
      return false;
    }

    if (!this.validateNumberOption('requestTimeout', this.config.requestTimeout, {
      min: 1000,
      max: 60000,
      integer: true,
    })) {
      return false;
    }

    if (!this.validateNumberOption('requestRetries', this.config.requestRetries, {
      min: 0,
      max: 5,
      integer: true,
    })) {
      return false;
    }

    if (!this.validateNumberOption('retryDelay', this.config.retryDelay, {
      min: 0,
      max: 60000,
      integer: true,
    })) {
      return false;
    }

    const invalidSensor = this.config.sensors.find(
      (sensor) =>
        !sensor ||
        typeof sensor.name !== 'string' ||
        sensor.name.trim() === '' ||
        typeof sensor.did !== 'string' ||
        sensor.did.trim() === '',
    );
    if (invalidSensor) {
      this.log.error('Every sensor must have a non-empty name and DID.');
      return false;
    }

    const dids = this.config.sensors.map((sensor) => sensor.did.trim());
    if (new Set(dids).size !== dids.length) {
      this.log.error('Each sensor must use a unique DID.');
      return false;
    }

    if (
      this.config.adaptivePolling !== undefined &&
      (!this.config.adaptivePolling ||
        typeof this.config.adaptivePolling !== 'object' ||
        Array.isArray(this.config.adaptivePolling))
    ) {
      this.log.error('adaptivePolling must be an object.');
      return false;
    }

    if (this.adaptivePollingEnabled) {
      if (!this.validateNumberOption(
        'adaptivePolling.activePollInterval',
        this.adaptivePolling.activePollInterval,
        { min: 10, max: 3600, integer: true },
      )) {
        return false;
      }

      if (!this.validateNumberOption(
        'adaptivePolling.motionHoldSeconds',
        this.adaptivePolling.motionHoldSeconds,
        { min: 30, max: 86400, integer: true },
      )) {
        return false;
      }

      if (this.activePollInterval >= this.pollInterval) {
        this.log.error('adaptivePolling.activePollInterval must be less than pollInterval.');
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
    if (this.stopped || this.authBlocked) return;
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
    this.setSensorFault(sensor, true);
  }

  setSensorFault(sensor, fault) {
    const accessory = this.accessories.get(this.api.hap.uuid.generate(sensor.did));
    if (!accessory || !Characteristic.StatusFault) return;
    for (const type of [Service.TemperatureSensor, Service.HumiditySensor]) {
      accessory.getService(type)?.updateCharacteristic(Characteristic.StatusFault, fault ? 1 : 0);
    }
  }

  async updateAll() {
    if (this.stopped || this.authBlocked) return;
    if (this.updateInProgress) {
      this.log.debug('Skipping update cycle because previous cycle is still running.');
      return;
    }

    this.updateInProgress = true;
    const sensors = this.config.sensors || [];
    let motionDetectedInCycle = false;
    let failed = 0;

    try {
      for (const sensor of sensors) {
        if (this.stopped) break;
        try {
          const motionDetected = await this.updateSensor(sensor);
          motionDetectedInCycle = motionDetectedInCycle || motionDetected;
          this.sensorErrors.delete(sensor.did);
        } catch (error) {
          failed++;
          if (error.code === 'XIAOMI_AUTH_REQUIRED') {
            this.authBlocked = true;
            for (const configured of sensors) this.setSensorFault(configured, true);
            this.log.error(this.sanitizeLogMessage(error.message));
            break;
          }
          const message = this.sanitizeLogMessage(error.message || error);
          if (this.sensorErrors.get(sensor.did) !== message) {
            this.log.warn(`Update failed for ${sensor.name}: ${message}`);
            this.sensorErrors.set(sensor.did, message);
          }
          const lastSuccess = this.lastSuccess.get(sensor.did) || 0;
          if (Date.now() - lastSuccess > this.staleAfterSeconds * 1000) this.setSensorFault(sensor, true);
        }
      }

      if (motionDetectedInCycle) {
        this.lastMotionDetectedAt = Date.now();
      }
    } finally {
      this.updateInProgress = false;
      this.failureCycles = failed === sensors.length ? Math.min(this.failureCycles + 1, 4) : 0;
      const baseInterval = this.getNextPollInterval();
      this.scheduleNextUpdate(Math.min(Math.max(900, baseInterval), baseInterval * (2 ** this.failureCycles)));
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
    if (this.stopped) return false;

    if (!Number.isFinite(temperature) || !Number.isFinite(humidity)) {
      throw new Error(`Invalid numeric payload for ${sensor.name}`);
    }
    if (temperature < -50 || temperature > 100 || humidity < 0 || humidity > 100) {
      throw new Error('Sensor measurement is outside the supported range');
    }
    const timestamps = this.cloud.readingTimes;
    // Cloud history records property changes, so unchanged temperature can be old
    // while a recent humidity report proves that the sensor is still reporting.
    const measuredAt = timestamps ? Math.max(timestamps.get(`${sensor.did}:4100`) || 0, timestamps.get(`${sensor.did}:4102`) || 0) : Date.now();
    if (Date.now() - measuredAt > this.staleAfterSeconds * 1000) {
      this.setSensorFault(sensor, true);
      throw new Error('Sensor data is stale; waiting for a fresh measurement');
    }
    this.lastSuccess.set(sensor.did, measuredAt);
    this.setSensorFault(sensor, false);

    const stateId = sensor.did;
    const temperatureChanged = this.deviceStates.temp[stateId] !== temperature;
    const humidityChanged = this.deviceStates.humidity[stateId] !== humidity;

    if (temperatureChanged) {
      tempService.updateCharacteristic(Characteristic.CurrentTemperature, temperature);
      this.deviceStates.temp[stateId] = temperature;
    }

    if (humidityChanged) {
      humService.updateCharacteristic(Characteristic.CurrentRelativeHumidity, humidity);
      this.deviceStates.humidity[stateId] = humidity;
    }

    const logMessage = `${sensor.name}: ${temperature}°C / ${humidity}%`;
    if (temperatureChanged || humidityChanged) {
      this.log.info(logMessage);
    } else {
      this.log.debug(logMessage);
    }

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
