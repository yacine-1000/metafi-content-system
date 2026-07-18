'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { getCampaign } = require('./campaignService');
const { localDateTimeToUtc } = require('../generation/scheduleBufferPost');

const ROOT = path.resolve(__dirname, '../..');
const CAMPAIGNS_DIR = path.join(ROOT, 'data', 'campaigns');
const RANDOM_START_MINUTE = 9 * 60;
const RANDOM_END_MINUTE = 22 * 60;

class CampaignPlannerError extends Error {}

function accountContext(campaign) {
  return {
    account_id: campaign.account_id,
    buffer_channel_id: campaign.buffer_channel_id,
    account_internal_name: campaign.account_internal_name,
    account_username: campaign.account_username,
    account_language: campaign.account_language,
    account_timezone: campaign.account_timezone,
  };
}

function writePlan(filePath, plan) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(plan, null, 2), 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

function applyAccountContext(plan, campaign) {
  Object.assign(plan, accountContext(campaign));
  if (Array.isArray(plan.slots)) plan.slots.forEach((slot) => Object.assign(slot, accountContext(campaign)));
  return plan;
}

function planPath(campaignId) {
  return path.join(CAMPAIGNS_DIR, `${campaignId}-plan.json`);
}

function largestRemainderCounts(totalSlots, pillars) {
  const allocations = pillars.map((pillar, index) => {
    const exact = (totalSlots * pillar.percentage) / 100;
    return {
      pillar_id: pillar.pillar_id,
      count: Math.floor(exact),
      remainder: exact - Math.floor(exact),
      index,
    };
  });
  let remaining = totalSlots - allocations.reduce((sum, item) => sum + item.count, 0);
  const remainderOrder = [...allocations].sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let index = 0; index < remaining; index += 1) remainderOrder[index].count += 1;
  return Object.fromEntries(allocations.map((item) => [item.pillar_id, item.count]));
}

function distributePillars(totalSlots, counts, pillarOrder) {
  const assigned = Object.fromEntries(pillarOrder.map((pillarId) => [pillarId, 0]));
  const sequence = [];
  for (let slotIndex = 0; slotIndex < totalSlots; slotIndex += 1) {
    const available = pillarOrder.filter((pillarId) => assigned[pillarId] < counts[pillarId]);
    available.sort((a, b) => {
      const deficitA = (counts[a] * (slotIndex + 1)) / totalSlots - assigned[a];
      const deficitB = (counts[b] * (slotIndex + 1)) / totalSlots - assigned[b];
      return deficitB - deficitA || pillarOrder.indexOf(a) - pillarOrder.indexOf(b);
    });
    const pillarId = available[0];
    assigned[pillarId] += 1;
    sequence.push(pillarId);
  }
  return sequence;
}

function seedFrom(value) {
  return crypto.createHash('sha256').update(value).digest().readUInt32LE(0);
}

function mulberry32(seed) {
  return function next() {
    let value = seed += 0x6D2B79F5;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function randomTimes(campaignId, date, count) {
  const availableMinutes = RANDOM_END_MINUTE - RANDOM_START_MINUTE + 1;
  if (count > availableMinutes) {
    throw new CampaignPlannerError(`random mode supports at most ${availableMinutes} unique daily posting times`);
  }
  const random = mulberry32(seedFrom(`${campaignId}:${date}`));
  const selected = new Set();
  while (selected.size < count) {
    selected.add(RANDOM_START_MINUTE + Math.floor(random() * availableMinutes));
  }
  return [...selected].sort((a, b) => a - b).map((minutes) => {
    const hour = Math.floor(minutes / 60);
    const minute = minutes % 60;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  });
}

function addDays(date, offset) {
  const [year, month, day] = date.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + offset));
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
}

function buildPlan(campaign) {
  const totalSlots = campaign.duration_days * campaign.posts_per_day;
  const pillarOrder = campaign.pillars.map((pillar) => pillar.pillar_id);
  const pillarCounts = largestRemainderCounts(totalSlots, campaign.pillars);
  const pillarSequence = distributePillars(totalSlots, pillarCounts, pillarOrder);
  const slots = [];

  for (let dayIndex = 0; dayIndex < campaign.duration_days; dayIndex += 1) {
    const date = addDays(campaign.start_date, dayIndex);
    const times = campaign.posting_time_mode === 'manual'
      ? [...campaign.posting_times]
      : randomTimes(campaign.campaign_id, date, campaign.posts_per_day);
    if (new Set(times).size !== times.length) {
      throw new CampaignPlannerError(`Campaign has duplicate posting times on ${date}`);
    }
    for (const time of times) {
      const slotIndex = slots.length;
      slots.push({
        slot_id: `${campaign.campaign_id}-slot-${String(slotIndex + 1).padStart(4, '0')}`,
        date,
        time,
        scheduled_at: localDateTimeToUtc(date, time, campaign.timezone),
        pillar_id: pillarSequence[slotIndex],
        hook_type: campaign.hook_types[slotIndex % campaign.hook_types.length],
        language: campaign.language,
        ...accountContext(campaign),
        publishing_mode: campaign.publishing_mode || 'mobile_finish',
        status: 'planned',
        post_id: null,
      });
    }
  }

  return {
    campaign_id: campaign.campaign_id,
    ...accountContext(campaign),
    status: 'planned',
    created_at: new Date().toISOString(),
    total_slots: totalSlots,
    timezone: campaign.timezone,
    publishing_mode: campaign.publishing_mode || 'mobile_finish',
    slots,
  };
}

function planCampaign(campaignId) {
  const campaign = getCampaign(campaignId);
  if (!campaign) return null;
  const filePath = planPath(campaign.campaign_id);
  if (fs.existsSync(filePath)) {
    const plan = applyAccountContext(JSON.parse(fs.readFileSync(filePath, 'utf8')), campaign);
    writePlan(filePath, plan);
    return { plan, existing: true };
  }
  const plan = buildPlan(campaign);
  fs.writeFileSync(filePath, JSON.stringify(plan, null, 2), { encoding: 'utf8', flag: 'wx' });
  return { plan, existing: false };
}

module.exports = {
  CampaignPlannerError,
  buildPlan,
  largestRemainderCounts,
  planCampaign,
};
