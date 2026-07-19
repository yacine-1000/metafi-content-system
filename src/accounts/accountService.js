'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const ACCOUNTS_DIR = path.join(ROOT, 'data', 'accounts');
const ACCOUNT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const LANGUAGES = new Set(['ar', 'en', 'es', 'fr', 'zh']);
const GENDERS = new Set(['male', 'female']);
const CONNECTION_STATUSES = new Set(['connected', 'manual_only']);
const INPUT_FIELDS = new Set([
  'account_id', 'internal_name', 'display_name', 'username', 'platform',
  'country', 'language', 'gender', 'timezone', 'buffer_organization_id', 'buffer_channel_id',
  'buffer_channel_name', 'connection_status', 'active',
]);

class AccountValidationError extends Error {}
class AccountConflictError extends Error {}

function ensureAccountsDir() {
  fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
}

function accountPath(accountId) {
  if (typeof accountId !== 'string' || !ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new AccountValidationError('Invalid account ID');
  }
  const filePath = path.resolve(ACCOUNTS_DIR, `${accountId}.json`);
  if (path.dirname(filePath) !== path.resolve(ACCOUNTS_DIR)) throw new AccountValidationError('Invalid account ID');
  return filePath;
}

function isValidTimezone(value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function readAccountFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function listAccounts() {
  ensureAccountsDir();
  return fs.readdirSync(ACCOUNTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => readAccountFile(path.join(ACCOUNTS_DIR, entry.name)))
    .sort((a, b) => String(a.internal_name).localeCompare(String(b.internal_name)));
}

function assertAllowedFields(input, allowAccountId) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AccountValidationError('Account body must be a JSON object');
  const allowed = allowAccountId ? INPUT_FIELDS : new Set([...INPUT_FIELDS].filter((field) => field !== 'account_id'));
  if (Object.keys(input).some((field) => !allowed.has(field))) throw new AccountValidationError('Account contains a locked or unsupported field');
}

function validateAccount(account) {
  accountPath(account.account_id);
  for (const field of ['internal_name', 'display_name', 'username', 'avatar_path', 'country', 'buffer_organization_id', 'buffer_channel_id', 'buffer_channel_name']) {
    if (typeof account[field] !== 'string') throw new AccountValidationError(`${field} must be a string`);
  }
  if (!account.internal_name.trim()) throw new AccountValidationError('internal_name is required');
  if (!account.display_name.trim()) throw new AccountValidationError('display_name is required');
  if (!account.username.trim()) throw new AccountValidationError('username is required');
  if (account.platform !== 'tiktok') throw new AccountValidationError('platform must be tiktok');
  if (!LANGUAGES.has(account.language)) throw new AccountValidationError('language must be ar, en, es, fr, or zh');
  if (!GENDERS.has(account.gender)) throw new AccountValidationError('gender must be male or female');
  if (typeof account.timezone !== 'string' || !isValidTimezone(account.timezone)) throw new AccountValidationError('timezone must be a valid IANA timezone');
  if (!CONNECTION_STATUSES.has(account.connection_status)) throw new AccountValidationError('connection_status must be connected or manual_only');
  if (typeof account.active !== 'boolean') throw new AccountValidationError('active must be a boolean');
  const hasBufferChannel = Boolean(account.buffer_channel_id.trim());
  if (account.connection_status === 'connected' && !hasBufferChannel) throw new AccountValidationError('buffer_channel_id is required for connected accounts');
  if (account.connection_status === 'manual_only' && hasBufferChannel) throw new AccountValidationError('manual_only accounts cannot have buffer_channel_id');
}

function assertUniqueBufferChannel(bufferChannelId, excludedAccountId = null) {
  if (!bufferChannelId || !bufferChannelId.trim()) return;
  const duplicate = listAccounts().find((account) => account.account_id !== excludedAccountId && account.buffer_channel_id === bufferChannelId);
  if (duplicate) throw new AccountConflictError('buffer_channel_id is already assigned to another account');
}

function getAccount(accountId) {
  ensureAccountsDir();
  const filePath = accountPath(accountId);
  return fs.existsSync(filePath) ? readAccountFile(filePath) : null;
}

function createAccount(input) {
  assertAllowedFields(input, true);
  const now = new Date().toISOString();
  const account = {
    account_id: input.account_id,
    internal_name: input.internal_name,
    display_name: input.display_name,
    username: input.username,
    avatar_path: input.avatar_path || '',
    platform: input.platform || 'tiktok',
    country: input.country || '',
    language: input.language,
    gender: input.gender || 'male',
    timezone: input.timezone,
    buffer_organization_id: input.buffer_organization_id || '',
    buffer_channel_id: input.buffer_channel_id || '',
    buffer_channel_name: input.buffer_channel_name || '',
    connection_status: input.connection_status || (input.buffer_channel_id ? 'connected' : 'manual_only'),
    active: input.active == null ? true : input.active,
    created_at: now,
    updated_at: now,
  };
  validateAccount(account);
  ensureAccountsDir();
  const filePath = accountPath(account.account_id);
  if (fs.existsSync(filePath)) throw new AccountConflictError('Account ID already exists');
  assertUniqueBufferChannel(account.buffer_channel_id);
  fs.writeFileSync(filePath, JSON.stringify(account, null, 2), { encoding: 'utf8', flag: 'wx' });
  return account;
}

function updateAccount(accountId, changes) {
  assertAllowedFields(changes, false);
  if (Object.keys(changes).length === 0) throw new AccountValidationError('No account fields supplied');
  const existing = getAccount(accountId);
  if (!existing) return null;
  const updated = { ...existing, ...changes, account_id: existing.account_id, created_at: existing.created_at, updated_at: new Date().toISOString() };
  validateAccount(updated);
  assertUniqueBufferChannel(updated.buffer_channel_id, accountId);
  fs.writeFileSync(accountPath(accountId), JSON.stringify(updated, null, 2), 'utf8');
  return updated;
}

function updateAccountAvatar(accountId, avatarPath) {
  const existing = getAccount(accountId);
  if (!existing) return null;
  const updated = { ...existing, avatar_path: avatarPath, updated_at: new Date().toISOString() };
  validateAccount(updated);
  fs.writeFileSync(accountPath(accountId), JSON.stringify(updated, null, 2), 'utf8');
  return updated;
}

module.exports = {
  AccountConflictError,
  AccountValidationError,
  createAccount,
  getAccount,
  listAccounts,
  updateAccount,
  updateAccountAvatar,
};
