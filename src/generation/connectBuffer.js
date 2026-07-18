'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const ROOT = path.resolve(__dirname, '../..');
const BUFFER_API_URL = 'https://api.buffer.com';

function readApiKey() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) {
    throw new Error(`Missing .env file: ${envPath}`);
  }

  const env = dotenv.parse(fs.readFileSync(envPath));
  if (!env.BUFFER_API_KEY || !env.BUFFER_API_KEY.trim()) {
    throw new Error('Missing required .env variable: BUFFER_API_KEY');
  }
  return env.BUFFER_API_KEY.trim();
}

async function graphql(apiKey, query, variables = {}) {
  const response = await fetch(BUFFER_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  const messages = Array.isArray(payload?.errors)
    ? payload.errors.map((error) => error.message).filter(Boolean)
    : [];
  const authenticationFailed = response.status === 401
    || response.status === 403
    || messages.some((message) => /auth|unauthorized|forbidden/i.test(message));

  if (authenticationFailed) throw new Error('Buffer authentication failed');
  if (!response.ok) throw new Error(`Buffer API request failed with HTTP ${response.status}`);
  if (messages.length > 0) throw new Error(`Buffer GraphQL error: ${messages.join('; ')}`);
  if (!payload?.data) throw new Error('Buffer API returned no data');
  return payload.data;
}

async function discoverBufferTikTokChannels() {
  const apiKey = readApiKey();
  const accountData = await graphql(apiKey, `
    query GetOrganizations {
      account {
        id
        organizations {
          id
          name
        }
      }
    }
  `);
  const organizations = accountData.account?.organizations || [];
  if (organizations.length === 0) throw new Error('No Buffer organization exists for this account');

  const tiktokChannels = [];
  for (const organization of organizations) {
    const channelData = await graphql(apiKey, `
      query GetChannels($organizationId: OrganizationId!) {
        channels(input: { organizationId: $organizationId }) {
          id
          name
          displayName
          service
          isDisconnected
        }
      }
    `, { organizationId: organization.id });

    for (const channel of channelData.channels || []) {
      if (String(channel.service).toLowerCase() === 'tiktok') {
        tiktokChannels.push({
          organization_id: organization.id,
          organization_name: organization.name,
          channel_id: channel.id,
          channel_name: channel.displayName || channel.name,
          username: channel.name,
          service: 'tiktok',
          is_disconnected: channel.isDisconnected === true,
        });
      }
    }
  }

  return tiktokChannels;
}

async function main() {
  const discoveredChannels = await discoverBufferTikTokChannels();
  const tiktokChannels = discoveredChannels.filter((channel) => !channel.is_disconnected);

  if (tiktokChannels.length === 0) throw new Error('No connected TikTok channel found');
  if (tiktokChannels.length > 1) {
    console.error('Multiple connected TikTok channels found; no channel was selected:');
    console.error(JSON.stringify(tiktokChannels.map((channel) => ({
      organization_id: channel.organization_id,
      organization_name: channel.organization_name,
      channel_id: channel.channel_id,
      channel_name: channel.channel_name,
      channel_service: channel.service,
      channel_username: channel.username,
    })), null, 2));
    throw new Error('Multiple TikTok channels exist and no exact channel can be chosen safely');
  }

  const channel = tiktokChannels[0];
  const connection = {
    provider: 'buffer',
    connected_at: new Date().toISOString(),
    organization_id: channel.organization_id,
    organization_name: channel.organization_name,
    channel_id: channel.channel_id,
    channel_name: channel.channel_name,
    channel_service: 'tiktok',
    channel_username: channel.username,
    status: 'connected',
  };
  const outputPath = path.join(ROOT, 'config', 'buffer-connection.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(connection, null, 2), 'utf8');
  console.log(`Connected Buffer organization "${connection.organization_name}" to TikTok channel "${connection.channel_name}"`);
  console.log(`Saved ${path.relative(ROOT, outputPath)}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Buffer connection failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { discoverBufferTikTokChannels };
