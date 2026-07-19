-- Metafi Content OS: hosted Phase 1 persistence only.
-- No auth, users, workspaces, memberships, roles, or tenant ownership model.

begin;

create extension if not exists pgcrypto with schema extensions;

-- Checkpoint 1: shared timestamp behavior.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Checkpoint 2: accounts and campaign planning.
create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  legacy_account_id text not null unique,
  internal_name text not null,
  display_name text not null,
  username text not null,
  platform text not null default 'tiktok' check (platform in ('tiktok')),
  country text not null default '',
  language text not null check (language in ('ar', 'en', 'es', 'fr', 'zh')),
  gender text not null check (gender in ('male', 'female')),
  timezone text not null,
  avatar_path text,
  connection_status text not null check (connection_status in ('connected', 'manual_only')),
  active boolean not null default true,
  default_publishing_mode text not null default 'mobile_finish'
    check (default_publishing_mode in ('automatic', 'mobile_finish')),
  buffer_organization_id text,
  buffer_channel_id text unique,
  buffer_channel_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (connection_status = 'connected' and nullif(buffer_channel_id, '') is not null)
    or (connection_status = 'manual_only' and nullif(buffer_channel_id, '') is null)
  )
);

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  legacy_campaign_id text not null unique,
  account_id uuid not null references public.accounts(id) on delete restrict,
  name text not null,
  objective text not null
    check (objective in ('brand_awareness', 'app_installs', 'account_warm_up', 'content_testing')),
  language text not null check (language in ('ar', 'en', 'es', 'fr')),
  timezone text not null,
  start_date date not null,
  duration_days integer not null check (duration_days > 0),
  posts_per_day integer not null check (posts_per_day > 0),
  pillars jsonb not null default '[]'::jsonb check (jsonb_typeof(pillars) = 'array'),
  hook_types jsonb not null default '[]'::jsonb check (jsonb_typeof(hook_types) = 'array'),
  posting_time_mode text not null check (posting_time_mode in ('manual', 'random')),
  posting_times jsonb not null default '[]'::jsonb check (jsonb_typeof(posting_times) = 'array'),
  publishing_mode text not null default 'mobile_finish'
    check (publishing_mode in ('automatic', 'mobile_finish')),
  status text not null default 'draft' check (status in ('draft', 'active', 'paused', 'completed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.campaign_slots (
  id uuid primary key default gen_random_uuid(),
  legacy_slot_id text not null unique,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete restrict,
  scheduled_date date not null,
  scheduled_time time not null,
  scheduled_at timestamptz not null,
  pillar_id text not null check (pillar_id in ('p1', 'p2', 'p3', 'p4')),
  hook_type text not null,
  language text not null check (language in ('ar', 'en', 'es', 'fr')),
  publishing_mode text not null check (publishing_mode in ('automatic', 'mobile_finish')),
  status text not null default 'planned'
    check (status in ('planned', 'generating', 'generated', 'approved', 'uploaded', 'notification_scheduled', 'buffered', 'published', 'failed', 'swapped')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  failure_code text,
  failure_reason text,
  claim_id uuid,
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, scheduled_at)
);

-- Checkpoint 3: durable generation state and generated post metadata.
create table public.generation_jobs (
  id uuid primary key default gen_random_uuid(),
  legacy_job_id text unique,
  account_id uuid not null references public.accounts(id) on delete restrict,
  campaign_id uuid references public.campaigns(id) on delete cascade,
  campaign_slot_id uuid references public.campaign_slots(id) on delete cascade,
  state text not null default 'queued'
    check (state in ('queued', 'claimed', 'selecting', 'resolving_assets', 'rendering', 'uploading', 'completed', 'failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  claim_token uuid,
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  error_code text,
  error_message text,
  progress jsonb not null default '{}'::jsonb check (jsonb_typeof(progress) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.posts (
  id uuid primary key default gen_random_uuid(),
  legacy_post_id text not null unique,
  account_id uuid not null references public.accounts(id) on delete restrict,
  campaign_id uuid references public.campaigns(id) on delete set null,
  campaign_slot_id uuid unique references public.campaign_slots(id) on delete set null,
  generation_job_id uuid references public.generation_jobs(id) on delete set null,
  language text not null check (language in ('ar', 'en', 'es', 'fr')),
  pillar_id text check (pillar_id in ('p1', 'p2', 'p3', 'p4')),
  hook_type text,
  topic_id text,
  master_script_id text,
  caption text not null default '',
  publish_package jsonb not null default '{}'::jsonb check (jsonb_typeof(publish_package) = 'object'),
  strategy_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(strategy_metadata) = 'object'),
  asset_manifest jsonb not null default '{}'::jsonb check (jsonb_typeof(asset_manifest) = 'object'),
  errors jsonb not null default '[]'::jsonb check (jsonb_typeof(errors) = 'array'),
  generation_status text not null default 'queued'
    check (generation_status in ('queued', 'generating', 'completed', 'failed')),
  review_status text not null default 'pending'
    check (review_status in ('pending', 'approved', 'rejected')),
  upload_status text not null default 'not_started'
    check (upload_status in ('not_started', 'uploading', 'uploaded', 'failed')),
  buffer_status text not null default 'not_sent'
    check (buffer_status in ('not_sent', 'draft', 'notification_scheduled', 'buffered', 'published', 'failed')),
  publication_status text not null default 'not_published'
    check (publication_status in ('not_published', 'published', 'failed')),
  publishing_mode text not null default 'mobile_finish'
    check (publishing_mode in ('automatic', 'mobile_finish')),
  saved_at timestamptz,
  local_path text,
  buffer_post_id text,
  buffer_channel_id text,
  buffer_scheduled_at timestamptz,
  buffer_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.account_assets (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  post_id uuid references public.posts(id) on delete cascade,
  asset_type text not null
    check (asset_type in ('profile', 'hook', 'localized_cta', 'rendered_slide', 'slides_zip')),
  language text check (language in ('ar', 'en', 'es', 'fr', 'zh')),
  hook_type text,
  slide_number integer check (slide_number is null or slide_number > 0),
  storage_provider text not null default 'local'
    check (storage_provider in ('local', 'r2', 'supabase_storage')),
  storage_bucket text,
  storage_key text not null,
  public_url text,
  content_type text not null,
  byte_size bigint check (byte_size is null or byte_size >= 0),
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  checksum_sha256 text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (asset_type <> 'localized_cta' or language is not null),
  check (asset_type not in ('rendered_slide', 'slides_zip') or post_id is not null),
  check (asset_type <> 'rendered_slide' or slide_number is not null),
  unique (account_id, storage_provider, storage_key)
);

-- Checkpoint 4: manual and Buffer publication lifecycle.
create table public.publication_history (
  id uuid primary key default gen_random_uuid(),
  legacy_publication_id text unique,
  post_id uuid not null references public.posts(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete restrict,
  campaign_id uuid references public.campaigns(id) on delete set null,
  campaign_slot_id uuid references public.campaign_slots(id) on delete set null,
  method text not null check (method in ('manual', 'buffer')),
  status text not null default 'published' check (status in ('scheduled', 'published', 'failed')),
  published_at timestamptz,
  confirmed_at timestamptz,
  external_url text,
  script_id text,
  source_set_id text,
  buffer_post_id text,
  buffer_channel_id text,
  buffer_status text,
  buffer_sent_at timestamptz,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (post_id)
);

-- Checkpoint 5: indexes for the current portal queries and runners.
create index accounts_active_idx on public.accounts (active, internal_name);
create index account_assets_account_type_language_idx on public.account_assets (account_id, asset_type, language) where active;
create index account_assets_post_idx on public.account_assets (post_id) where post_id is not null;
create index campaigns_account_status_idx on public.campaigns (account_id, status, created_at desc);
create index campaigns_schedule_idx on public.campaigns (status, start_date);
create index campaign_slots_campaign_schedule_idx on public.campaign_slots (campaign_id, scheduled_at);
create index campaign_slots_runnable_idx on public.campaign_slots (status, scheduled_at) where status in ('planned', 'failed');
create index generation_jobs_claimable_idx on public.generation_jobs (state, created_at) where state in ('queued', 'failed');
create index generation_jobs_campaign_idx on public.generation_jobs (campaign_id, created_at desc);
create index posts_campaign_created_idx on public.posts (campaign_id, created_at desc);
create index posts_account_created_idx on public.posts (account_id, created_at desc);
create index posts_quick_save_idx on public.posts (campaign_id, saved_at, created_at) where generation_status = 'completed';
create index posts_buffer_status_idx on public.posts (buffer_status, buffer_scheduled_at);
create index publication_history_account_published_idx on public.publication_history (account_id, published_at desc);
create index publication_history_buffer_post_idx on public.publication_history (buffer_post_id) where buffer_post_id is not null;

-- Checkpoint 6: updated_at triggers.
create trigger accounts_set_updated_at before update on public.accounts for each row execute function public.set_updated_at();
create trigger account_assets_set_updated_at before update on public.account_assets for each row execute function public.set_updated_at();
create trigger campaigns_set_updated_at before update on public.campaigns for each row execute function public.set_updated_at();
create trigger campaign_slots_set_updated_at before update on public.campaign_slots for each row execute function public.set_updated_at();
create trigger posts_set_updated_at before update on public.posts for each row execute function public.set_updated_at();
create trigger generation_jobs_set_updated_at before update on public.generation_jobs for each row execute function public.set_updated_at();
create trigger publication_history_set_updated_at before update on public.publication_history for each row execute function public.set_updated_at();

-- Checkpoint 7: deny browser Data API access. No user-dependent policies exist.
alter table public.accounts enable row level security;
alter table public.account_assets enable row level security;
alter table public.campaigns enable row level security;
alter table public.campaign_slots enable row level security;
alter table public.posts enable row level security;
alter table public.generation_jobs enable row level security;
alter table public.publication_history enable row level security;

revoke all on table public.accounts from anon, authenticated;
revoke all on table public.account_assets from anon, authenticated;
revoke all on table public.campaigns from anon, authenticated;
revoke all on table public.campaign_slots from anon, authenticated;
revoke all on table public.posts from anon, authenticated;
revoke all on table public.generation_jobs from anon, authenticated;
revoke all on table public.publication_history from anon, authenticated;
revoke execute on function public.set_updated_at() from public, anon, authenticated;

grant select, insert, update, delete on table public.accounts to service_role;
grant select, insert, update, delete on table public.account_assets to service_role;
grant select, insert, update, delete on table public.campaigns to service_role;
grant select, insert, update, delete on table public.campaign_slots to service_role;
grant select, insert, update, delete on table public.posts to service_role;
grant select, insert, update, delete on table public.generation_jobs to service_role;
grant select, insert, update, delete on table public.publication_history to service_role;
grant execute on function public.set_updated_at() to service_role;

commit;
