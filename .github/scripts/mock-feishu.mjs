// CI-only preload: validate the full request locally; never send network traffic.
import assert from 'node:assert/strict';

globalThis.fetch = async (url, init) => {
  assert.equal(url, 'https://ci.invalid/hook');
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  const payload = JSON.parse(init.body);
  assert.equal(payload.msg_type, 'interactive');
  assert.equal(payload.card.schema, '2.0');
  const details = payload.card.body.elements[0].content;
  assert.ok(details.includes('smoke-check'));
  const reason = payload.card.body.elements[1].content;
  assert.ok(reason.includes('smoke failure: [已隐藏]'));
  assert.ok(!init.body.includes('private-smoke-token'));
  return { ok: true, json: async () => ({ code: 0 }) };
};
