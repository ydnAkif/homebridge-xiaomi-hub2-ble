const axios = require('axios');
const crypto = require('crypto');

class XiaomiCloud {
  constructor(options) {
    this.country = options.country || 'tw';
    this.userId = options.userId;
    this.ssecurity = options.ssecurity;
    this.serviceToken = options.serviceToken;
    this.log = options.log;
    this.requestTimeout = Number(options.requestTimeout || 15000);
    this.requestRetries = Math.max(Number(options.requestRetries || 2), 0);
    this.retryDelay = Math.max(Number(options.retryDelay || 1000), 0);
  }

  redactSensitive(value) {
    if (value === undefined || value === null) {
      return value;
    }

    let text = String(value);
    const secrets = [this.userId, this.ssecurity, this.serviceToken].filter(Boolean);

    for (const secret of secrets) {
      text = text.split(String(secret)).join('[REDACTED]');
    }

    return text;
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  shouldRetryRequestError(error) {
    const status = error?.response?.status;

    if (!status) {
      return true;
    }

    return status === 429 || status >= 500;
  }

  formatRequestError(error) {
    const status = error?.response?.status;
    const code = error?.code;

    if (status) {
      return `HTTP ${status}`;
    }

    if (code) {
      return this.redactSensitive(`${code}: ${error.message || 'Unknown request error'}`);
    }

    return this.redactSensitive(error?.message || 'Unknown request error');
  }

  async postWithRetry(url, fields, path) {
    let lastError;

    for (let attempt = 0; attempt <= this.requestRetries; attempt++) {
      try {
        return await axios.post(url, null, {
          params: fields,
          timeout: this.requestTimeout,
          headers: {
            Accept: '*/*',
            'Accept-Encoding': 'identity',
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Android-7.1.1-1.0.0-ONEPLUS A3010-136-ABCDABCDABCDABCD',
            'x-xiaomi-protocal-flag-cli': 'PROTOCAL-HTTP2',
            'MIOT-ENCRYPT-ALGORITHM': 'ENCRYPT-RC4',
            Cookie: [
              `userId=${this.userId}`,
              `yetAnotherServiceToken=${this.serviceToken}`,
              `serviceToken=${this.serviceToken}`,
              'locale=en_GB',
              'timezone=GMT+03:00',
              'is_daylight=1',
              'dst_offset=3600000',
              'channel=MI_APP_STORE',
            ].join('; '),
          },
        });
      } catch (error) {
        lastError = error;

        if (attempt >= this.requestRetries || !this.shouldRetryRequestError(error)) {
          break;
        }

        const delay = this.retryDelay * (2 ** attempt);
        if (this.log && typeof this.log.warn === 'function') {
          this.log.warn(
            this.redactSensitive(`Xiaomi Cloud request failed for ${path} (${this.formatRequestError(error)}). Retrying in ${delay}ms.`),
          );
        }

        await this.sleep(delay);
      }
    }

    throw new Error(this.redactSensitive(`Xiaomi Cloud request failed for ${path}: ${this.formatRequestError(lastError)}`));
  }

  apiUrl(path) {
    const prefix = this.country === 'cn' ? '' : `${this.country}.`;
    return `https://${prefix}api.io.mi.com/app${path}`;
  }

  generateNonce() {
    const random = crypto.randomBytes(8);
    const minutes = Math.floor(Date.now() / 60000);
    const minuteBytes = Buffer.alloc(4);

    minuteBytes.writeUInt32BE(minutes);

    return Buffer.concat([random, minuteBytes]).toString('base64');
  }

  signedNonce(nonce) {
    return crypto
      .createHash('sha256')
      .update(
        Buffer.concat([
          Buffer.from(this.ssecurity, 'base64'),
          Buffer.from(nonce, 'base64'),
        ]),
      )
      .digest('base64');
  }

  rc4(keyBase64, payload) {
    const key = Buffer.from(keyBase64, 'base64');
    const input = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);

    const s = new Array(256);

    for (let i = 0; i < 256; i++) {
      s[i] = i;
    }

    let j = 0;

    for (let i = 0; i < 256; i++) {
      j = (j + s[i] + key[i % key.length]) & 255;
      const temp = s[i];
      s[i] = s[j];
      s[j] = temp;
    }

    let i = 0;
    j = 0;

    const nextByte = () => {
      i = (i + 1) & 255;
      j = (j + s[i]) & 255;

      const temp = s[i];
      s[i] = s[j];
      s[j] = temp;

      return s[(s[i] + s[j]) & 255];
    };

    for (let n = 0; n < 1024; n++) {
      nextByte();
    }

    const output = Buffer.alloc(input.length);

    for (let n = 0; n < input.length; n++) {
      output[n] = input[n] ^ nextByte();
    }

    return output;
  }

  encryptRc4(keyBase64, text) {
    return this.rc4(keyBase64, text).toString('base64');
  }

  decryptRc4(keyBase64, text) {
    return this.rc4(keyBase64, Buffer.from(text, 'base64')).toString('utf8');
  }

  generateSignature(url, method, signedNonce, params) {
    const path = url.split('com')[1].replace('/app/', '/');
    const parts = [method.toUpperCase(), path];

    for (const [key, value] of Object.entries(params)) {
      parts.push(`${key}=${value}`);
    }

    parts.push(signedNonce);

    return crypto
      .createHash('sha1')
      .update(parts.join('&'))
      .digest('base64');
  }

  generateEncryptedParams(url, method, signedNonce, nonce, params) {
    const fields = { ...params };

    fields.rc4_hash__ = this.generateSignature(url, method, signedNonce, fields);

    for (const key of Object.keys(fields)) {
      fields[key] = this.encryptRc4(signedNonce, fields[key]);
    }

    fields.signature = this.generateSignature(url, method, signedNonce, fields);
    fields.ssecurity = this.ssecurity;
    fields._nonce = nonce;

    return fields;
  }

  async request(path, params) {
    const url = this.apiUrl(path);
    const nonce = this.generateNonce();
    const signedNonce = this.signedNonce(nonce);
    const fields = this.generateEncryptedParams(url, 'POST', signedNonce, nonce, params);

    const response = await this.postWithRetry(url, fields, path);

    if (response && typeof response.data === 'object' && response.data !== null) {
      return response.data;
    }

    if (typeof response?.data !== 'string') {
      throw new Error(`Unexpected Xiaomi response format for ${path}`);
    }

    let decoded;
    try {
      decoded = this.decryptRc4(this.signedNonce(fields._nonce), response.data);
    } catch (error) {
      throw new Error(`Failed to decrypt Xiaomi response for ${path}: ${error.message || error}`);
    }

    try {
      return JSON.parse(decoded);
    } catch (error) {
      if (this.log && typeof this.log.warn === 'function') {
        this.log.warn('Invalid data from Xiaomi Cloud');
      }
      return null;
    }
  }

  async getUserDeviceData(did, key) {
    const now = Math.floor(Date.now() / 1000);

    const response = await this.request('/user/get_user_device_data', {
      data: JSON.stringify({
        did,
        key,
        type: 'prop',
        time_end: now,
        limit: 1,
      }),
    });

    if (!response) {
      throw new Error('Invalid data from Xiaomi Cloud');
    }

    if (response.code !== 0) {
      throw new Error(this.redactSensitive(`Xiaomi Cloud error: ${JSON.stringify(response)}`));
    }

    if (!response.result || response.result.length === 0) {
      throw new Error(`No data for did=${did}, key=${key}`);
    }

    return response.result[0].value;
  }

  async getTemperature(did) {
    const raw = await this.getUserDeviceData(did, '4100');
    return this.decodeBleValue(raw);
  }

  async getHumidity(did) {
    const raw = await this.getUserDeviceData(did, '4102');
    return this.decodeBleValue(raw);
  }

  async getRawValue(did, key) {
    return this.getUserDeviceData(did, key);
  }

  decodeBleValue(raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Invalid BLE payload JSON: ${error.message || error}`);
    }

    if (!Array.isArray(parsed) || parsed.length === 0 || typeof parsed[0] !== 'string') {
      throw new Error(`Invalid BLE payload structure: ${raw}`);
    }

    const hex = parsed[0];
    if (hex.length < 4) {
      throw new Error(`Invalid BLE hex payload: ${hex}`);
    }

    const lo = parseInt(hex.slice(0, 2), 16);
    const hi = parseInt(hex.slice(2, 4), 16);

    if (Number.isNaN(lo) || Number.isNaN(hi)) {
      throw new Error(`Invalid BLE hex bytes: ${hex}`);
    }

    return ((hi << 8) | lo) / 10;
  }
}

module.exports = XiaomiCloud;
