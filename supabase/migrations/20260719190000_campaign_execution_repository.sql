begin;

create table public.campaign_execution_summaries (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null unique references public.campaigns(id) on delete cascade,
  summary jsonb not null check (jsonb_typeof(summary) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger campaign_execution_summaries_set_updated_at before update on public.campaign_execution_summaries for each row execute function public.set_updated_at();
alter table public.campaign_execution_summaries enable row level security;
revoke all on public.campaign_execution_summaries from anon, authenticated;
grant select, insert, update, delete on public.campaign_execution_summaries to service_role;

create or replace function public.claim_campaign_slot(p_campaign_id uuid, p_slot_id uuid, p_claim_id uuid, p_now timestamptz, p_lease_expires_at timestamptz)
returns setof public.campaign_slots language sql security definer set search_path = public as $$
  update public.campaign_slots set status = 'generating', claim_id = p_claim_id, claimed_at = p_now, claim_expires_at = p_lease_expires_at, updated_at = now()
  where id = p_slot_id and campaign_id = p_campaign_id and status in ('planned','failed')
    and (claim_expires_at is null or claim_expires_at <= p_now)
  returning *;
$$;

create or replace function public.finalize_campaign_slot(p_campaign_id uuid, p_slot_id uuid, p_claim_id uuid, p_status text, p_failure_code text default null, p_failure_reason text default null)
returns setof public.campaign_slots language sql security definer set search_path = public as $$
  update public.campaign_slots set status = p_status, failure_code = p_failure_code, failure_reason = p_failure_reason,
    claim_id = null, claimed_at = null, claim_expires_at = null, updated_at = now()
  where id = p_slot_id and campaign_id = p_campaign_id and claim_id = p_claim_id and status = 'generating'
    and p_status in ('generated','failed')
  returning *;
$$;
revoke all on function public.claim_campaign_slot(uuid,uuid,uuid,timestamptz,timestamptz) from public, anon, authenticated;
revoke all on function public.finalize_campaign_slot(uuid,uuid,uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.claim_campaign_slot(uuid,uuid,uuid,timestamptz,timestamptz) to service_role;
grant execute on function public.finalize_campaign_slot(uuid,uuid,uuid,text,text,text) to service_role;
commit;
