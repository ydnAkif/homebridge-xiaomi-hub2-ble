const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const XiaomiCloud = require('../src/xiaomiCloud');

test.afterEach(() => {
  axios.post = originalAxiosPost;
});

const originalAxiosPost = axios.post;

function createCloud(overrides = {}) {
  return new XiaomiCloud({
    userId: 'user-id',
    ssecurity: 'AA==',
    serviceToken: 'service-token',
    log: { warn() {} },
    requestRetries: 1,
    retryDelay: 0,
    ...overrides,
  });
}

test('decodeBleValue decodes little-endian BLE values', () => {
  const cloud = createCloud();

  assert.equal(cloud.decodeBleValue('["0201"]'), 25.8);
});

test('expired token latches an actionable auth error without retrying', async () => {
  const cloud = createCloud();
  let calls = 0;
  axios.post = async () => { calls++; throw Object.assign(new Error('expired'), { response: { status: 426, data: { message: 'SERVICETOKEN_EXPIRED' } } }); };
  for (let i = 0; i < 2; i++) {
    await assert.rejects(cloud.postWithRetry('https://example.test', {}, '/test'), { code: 'XIAOMI_AUTH_REQUIRED' });
  }
  assert.equal(calls, 1);
});

test('reading timestamps are retained and missing timestamps are rejected', async () => {
  const cloud = createCloud();
  const time = Math.floor(Date.now() / 1000);
  cloud.request = async () => ({ code: 0, result: [{ time, value: '["0201"]' }] });
  assert.equal(await cloud.getTemperature('1'), 25.8);
  assert.equal(cloud.readingTimes.get('1:4100'), time * 1000);
  cloud.request = async () => ({ code: 0, result: [{ value: '["0201"]' }] });
  await assert.rejects(cloud.getTemperature('1'), /timestamp/);
});

test('malformed hexadecimal BLE values are rejected rather than partially parsed', () => {
  const cloud = createCloud();
  for (const value of ['["0g01"]', '["020100"]', '["01"]']) assert.throws(() => cloud.decodeBleValue(value));
});

test('shouldRetryRequestError retries transient failures only', () => {
  const cloud = createCloud();

  assert.equal(cloud.shouldRetryRequestError({ response: { status: 503 } }), true);
  assert.equal(cloud.shouldRetryRequestError({ response: { status: 429 } }), true);
  assert.equal(cloud.shouldRetryRequestError({ code: 'ECONNABORTED' }), true);
  assert.equal(cloud.shouldRetryRequestError({ response: { status: 401 } }), false);
});

test('request retries once and returns parsed response', async () => {
  const warnings = [];
  const cloud = createCloud({
    log: {
      warn(message) {
        warnings.push(message);
      },
    },
  });

  cloud.generateNonce = () => 'nonce';
  cloud.signedNonce = () => 'signed-nonce';
  cloud.generateEncryptedParams = () => ({ _nonce: 'nonce', data: 'encrypted' });
  cloud.decryptRc4 = () => '{"code":0,"result":[{"value":"[\\"0201\\"]"}]}' ;

  let attempts = 0;
  axios.post = async () => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error('Temporary upstream failure');
      error.response = { status: 503 };
      throw error;
    }

    return { data: 'encrypted-response' };
  };

  const response = await cloud.request('/user/get_user_device_data', { data: '{}' });

  assert.equal(attempts, 2);
  assert.equal(warnings.length, 1);
  assert.deepEqual(response, {
    code: 0,
    result: [{ value: '["0201"]' }],
  });
});

test('request warns and returns null on invalid JSON payload', async () => {
  const warnings = [];
  const cloud = createCloud({
    log: {
      warn(message) {
        warnings.push(message);
      },
    },
  });

  cloud.generateNonce = () => 'nonce';
  cloud.signedNonce = () => 'signed-nonce';
  cloud.generateEncryptedParams = () => ({ _nonce: 'nonce', data: 'encrypted' });
  cloud.decryptRc4 = () => '{invalid-json';

  axios.post = async () => ({ data: 'encrypted-response' });

  const response = await cloud.request('/user/get_user_device_data', { data: '{}' });

  assert.equal(response, null);
  assert.equal(warnings.includes('Invalid data from Xiaomi Cloud'), true);
});
