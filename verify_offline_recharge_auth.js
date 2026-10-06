'use strict';

const assert = require('assert');
const security = require('./security');

async function checkRole(type, expectedStatus) {
  const token = security.issueToken({ username: 'recharge-check', type, scope: 'recharge-check' });
  const req = { headers: { authorization: 'Bearer ' + token }, originalUrl: '/api/advertiser/recharge', method: 'POST' };
  let status = 200;
  let body = null;
  let nextCalled = false;
  const res = {
    status(value) { status = value; return this; },
    json(value) { body = value; return this; },
  };
  await security.requireAuth('admin')(req, res, () => { nextCalled = true; });
  assert.strictEqual(status, expectedStatus, type + ' response status');
  assert.strictEqual(nextCalled, expectedStatus === 200, type + ' authorization result');
  if (expectedStatus !== 200) assert.strictEqual(body.error, 'unauthorized');
}

(async () => {
  await checkRole('advertiser', 401);
  await checkRole('admin', 200);
  const notify = { cid: 17, crid: 4, impid: 'pilot-imp-1', reqid: 'pilot-req-1', price: 2500000, win: true };
  const signature = security.notifySignature(notify);
  assert.strictEqual(security.verifyNotifySignature(notify, signature), true, 'valid internal notify signature');
  assert.strictEqual(security.verifyNotifySignature({ ...notify, price: 1 }, signature), false, 'tampered charge rejected');
  console.log('PASS: admin-only top-up and signed /notify integrity');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});