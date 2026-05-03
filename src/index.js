const XiaomiHub2BLEPlatform = require('./platform');

module.exports = (api) => {
  api.registerPlatform('XiaomiHub2BLE', XiaomiHub2BLEPlatform);
};