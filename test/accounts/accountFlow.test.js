'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const servicePath = path.join(ROOT, 'src', 'accounts', 'accountService.js');
const accountsDir = path.join(ROOT, 'data', 'accounts');

function productionAccountHashes() {
  return Object.fromEntries(fs.readdirSync(accountsDir).filter((name) => name.endsWith('.json')).map((name) => {
    const contents = fs.readFileSync(path.join(accountsDir, name));
    return [name, crypto.createHash('sha256').update(contents).digest('hex')];
  }));
}

test('Add an Account supports manual-only and connected temporary fixtures', () => {
  const before = productionAccountHashes();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'metafi-account-flow-'));
  process.env.METAFI_ACCOUNTS_DIR = temporary;
  delete require.cache[require.resolve(servicePath)];
  const { createAccount, getAccount } = require(servicePath);

  try {
    const base = { internal_name: 'Fixture', display_name: 'Fixture', username: 'fixture', platform: 'tiktok', country: 'SA', timezone: 'Asia/Riyadh', language: 'ar', gender: 'female' };
    const manual = createAccount(base);
    assert.match(manual.account_id, /^account_[a-f0-9]{24}$/);
    assert.equal(manual.connection_status, 'manual_only');
    assert.equal(manual.buffer_channel_id, '');
    assert.equal(getAccount(manual.account_id).account_id, manual.account_id);

    const connected = createAccount({ ...base, internal_name: 'Connected fixture', buffer_organization_id: 'org_fixture', buffer_channel_id: 'channel_fixture', buffer_channel_name: 'Fixture channel' });
    assert.equal(connected.connection_status, 'connected');
    assert.equal(connected.buffer_channel_id, 'channel_fixture');
    assert.notEqual(connected.account_id, manual.account_id);
  } finally {
    delete process.env.METAFI_ACCOUNTS_DIR;
    delete require.cache[require.resolve(servicePath)];
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  assert.deepEqual(productionAccountHashes(), before, 'existing account fixtures must remain byte-for-byte unchanged');
});

test('visual uploads are isolated from Save Account and use the returned stable account ID', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'index.html'), 'utf8');
  const saveBody = html.slice(html.indexOf('async function saveAccount()'), html.indexOf('let _campaignWizardStep'));
  assert.doesNotMatch(saveBody, /\/avatar|\/hook-images|\/app-cta-images/);
  assert.match(html, /accounts\/\$\{encodeURIComponent\(_accountEditingId\)\}\/avatar/);
  assert.match(html, /accounts\/\$\{encodeURIComponent\(accountId\)\}\/hook-images/);
  assert.match(html, /accounts\/\$\{encodeURIComponent\(accountId\)\}\/app-cta-images/);
  assert.match(saveBody, /fillAccountForm\(refreshed, null\)/);
});
