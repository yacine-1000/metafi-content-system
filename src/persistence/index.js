'use strict';

const { LocalRepository } = require('./localRepository');
const { SupabaseRepository } = require('./supabaseRepository');
const { createServerSupabaseClient, persistenceMode } = require('./serverSupabaseClient');

function createPersistenceRepository({ env = process.env, root, client } = {}) {
  const mode = persistenceMode(env);
  if (mode === 'local') return new LocalRepository({ root });
  return new SupabaseRepository(client || createServerSupabaseClient(env));
}

module.exports = { createPersistenceRepository };

