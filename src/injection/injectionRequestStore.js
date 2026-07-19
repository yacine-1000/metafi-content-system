'use strict';

const fs = require('fs');
const path = require('path');

class InjectionRequestStoreError extends Error {}

function createInjectionRequestStore(options = {}) {
  const filePath = path.resolve(options.filePath || path.join(__dirname, '..', '..', 'data', 'injection-requests.json'));

  function read() {
    if (!fs.existsSync(filePath)) return { injection_requests: [] };
    try {
      const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!value || !Array.isArray(value.injection_requests)) throw new Error('root must contain injection_requests');
      return value;
    } catch (error) {
      throw new InjectionRequestStoreError(`Invalid injection request store: ${error.message}`);
    }
  }

  function save(request) {
    const required = ['injection_id', 'source_set_id', 'status', 'priority', 'requested_at'];
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new InjectionRequestStoreError('Injection request must be an object');
    for (const field of required) if (typeof request[field] !== 'string' || request[field].trim() === '') throw new InjectionRequestStoreError(`${field} is required`);
    if (!/^INJ-[A-Za-z0-9_-]+$/.test(request.injection_id)) throw new InjectionRequestStoreError('injection_id is invalid');
    if (!/^SET-\d{3,}$/.test(request.source_set_id)) throw new InjectionRequestStoreError('source_set_id is invalid');
    for (const field of ['campaign_id', 'account_id', 'target_date', 'consumed_by_slot_id']) {
      if (request[field] != null && typeof request[field] !== 'string') throw new InjectionRequestStoreError(`${field} must be a string or null`);
    }
    if (Number.isNaN(Date.parse(request.requested_at))) throw new InjectionRequestStoreError('requested_at must be an ISO-compatible timestamp');
    if (request.target_date != null && !/^\d{4}-\d{2}-\d{2}$/.test(request.target_date)) throw new InjectionRequestStoreError('target_date must be YYYY-MM-DD or null');
    const store = read();
    if (store.injection_requests.some((item) => item.injection_id === request.injection_id)) throw new InjectionRequestStoreError(`Duplicate injection_id "${request.injection_id}"`);
    const normalized = {
      injection_id: request.injection_id,
      source_set_id: request.source_set_id,
      campaign_id: request.campaign_id ?? null,
      account_id: request.account_id ?? null,
      status: request.status,
      priority: request.priority,
      requested_at: request.requested_at,
      target_date: request.target_date ?? null,
      consumed_by_slot_id: request.consumed_by_slot_id ?? null,
    };
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(temporaryPath, `${JSON.stringify({ injection_requests: [...store.injection_requests, normalized] }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporaryPath, filePath);
    return normalized;
  }

  return { list: () => read().injection_requests, save };
}

module.exports = { InjectionRequestStoreError, createInjectionRequestStore };
