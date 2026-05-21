create table if not exists public.content_posts (
  id               uuid        primary key default gen_random_uuid(),
  post_id          text        unique not null,
  job_id           text        null,
  source_type      text        null,
  raw_input        text        null,
  caption          text        null,
  hashtags         jsonb       not null default '[]'::jsonb,
  statuses         jsonb       not null default '{}'::jsonb,
  assets           jsonb       not null default '{}'::jsonb,
  supabase         jsonb       null,
  buffer           jsonb       null,
  publish          jsonb       null,
  strategy_metadata jsonb      null,
  errors           jsonb       not null default '[]'::jsonb,
  local_path       text        null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create unique index if not exists content_posts_post_id_idx   on public.content_posts (post_id);
create        index if not exists content_posts_created_at_idx on public.content_posts (created_at desc);
create        index if not exists content_posts_statuses_idx   on public.content_posts using gin (statuses);
