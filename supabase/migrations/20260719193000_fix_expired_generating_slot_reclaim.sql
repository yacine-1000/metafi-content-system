begin;

create or replace function public.claim_campaign_slot(p_campaign_id uuid, p_slot_id uuid, p_claim_id uuid, p_now timestamptz, p_lease_expires_at timestamptz)
returns setof public.campaign_slots language sql security definer set search_path = public as $$
  update public.campaign_slots set status = 'generating', claim_id = p_claim_id, claimed_at = p_now, claim_expires_at = p_lease_expires_at, updated_at = now()
  where id = p_slot_id and campaign_id = p_campaign_id
    and (status in ('planned', 'failed') or (status = 'generating' and claim_expires_at <= p_now))
    and (claim_expires_at is null or claim_expires_at <= p_now)
  returning *;
$$;

revoke all on function public.claim_campaign_slot(uuid,uuid,uuid,timestamptz,timestamptz) from public, anon, authenticated;
grant execute on function public.claim_campaign_slot(uuid,uuid,uuid,timestamptz,timestamptz) to service_role;

commit;
