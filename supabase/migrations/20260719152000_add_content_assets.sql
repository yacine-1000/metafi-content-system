-- Shared visual banks are global content resources, never account-owned assets.

begin;

create table public.content_assets (
  id uuid primary key default gen_random_uuid(),
  legacy_id text not null unique,
  asset_type text not null check (asset_type in ('body', 'shared_hook', 'app_screenshot', 'brand', 'final_slide')),
  bank text not null,
  pillar text,
  hook_type text,
  language text check (language in ('ar', 'en', 'es', 'fr', 'zh')),
  storage_provider text not null default 'local'
    check (storage_provider in ('local', 'r2', 'supabase_storage')),
  bucket text,
  storage_key text not null,
  mime_type text not null,
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  checksum text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (storage_provider, bucket, storage_key)
);

create index content_assets_bank_type_active_idx on public.content_assets (bank, asset_type) where active;
create index content_assets_language_idx on public.content_assets (language) where language is not null and active;

create trigger content_assets_set_updated_at before update on public.content_assets
  for each row execute function public.set_updated_at();

alter table public.content_assets enable row level security;
revoke all on table public.content_assets from anon, authenticated;
grant select, insert, update, delete on table public.content_assets to service_role;

commit;
