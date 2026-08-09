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
  assert.equal(cloud.decodeBleValue('["9cff"]'), -10);
});

test('constructor bounds unsafe request settings', () => {
  const cloud = createCloud({
    requestTimeout: 'invalid',
    requestRetries: 100,
    retryDelay: -10,
  });

  assert.equal(cloud.requestTimeout, 15000);
  assert.equal(cloud.requestRetries, 5);
  assert.equal(cloud.retryDelay, 0);
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
