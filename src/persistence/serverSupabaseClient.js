'use strict';

const { createClient } = require('@supabase/supabase-js');

class PersistenceConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PersistenceConfigurationError';
  }
}

function persistenceMode(env = process.env) {
  const mode = String(env.METAFI_PERSISTENCE_MODE || 'local').trim().toLowerCase();
  if (mode === 'local' || mode === 'supabase') return mode;
  throw new PersistenceConfigurationError('METAFI_PERSISTENCE_MODE must be "local" or "supabase"');
}

function createServerSupabaseClient(env = process.env) {
  const url = String(env.SUPABASE_URL || '').trim();
  const serviceRoleKey = String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url) throw new PersistenceConfigurationError('SUPABASE_URL is required when METAFI_PERSISTENCE_MODE=supabase');
  if (!serviceRoleKey) throw new PersistenceConfigurationError('SUPABASE_SERVICE_ROLE_KEY is required when METAFI_PERSISTENCE_MODE=supabase');
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

module.exports = { PersistenceConfigurationError, createServerSupabaseClient, persistenceMode };

