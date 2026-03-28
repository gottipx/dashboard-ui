-- OpenClaw dashboard schema (per-user data with RLS)

create table if not exists public.tags (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null,
  color text not null,
  created_at timestamptz not null default now(),
  unique (user_id, label)
);

create table if not exists public.projects (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  code text not null,
  title text not null,
  description text not null,
  docs jsonb not null default '[]'::jsonb,
  instruction text not null,
  manager text not null,
  tag_ids text[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (user_id, code)
);

create table if not exists public.tasks (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  description text not null,
  project text not null,
  agent text not null,
  priority text not null check (priority in ('High','Medium','Low')),
  status text not null check (status in ('Todo','In Progress','Done')),
  resolved_at timestamptz,
  tag_ids text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists public.issues (
  key text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  sequence int not null,
  title text not null,
  description text not null,
  issue_type text not null,
  priority text not null,
  owner text not null,
  reporter text not null,
  story_points int not null default 0,
  acceptance_criteria text not null default '',
  lane text not null check (lane in ('backlog','in-progress','review','done')),
  order_index int not null default 0,
  resolved_at timestamptz,
  project_code text not null,
  project_name text not null,
  tag_ids text[] not null default '{}',
  created_at timestamptz not null default now()
);

alter table public.tasks add column if not exists resolved_at timestamptz;
alter table public.issues add column if not exists resolved_at timestamptz;

create table if not exists public.agents (
  name text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  state text not null check (state in ('ready','running','down')),
  info text not null,
  logs text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists public.calendar_events (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  event_time timestamptz not null,
  owner text not null,
  state text not null check (state in ('healthy','running','warning','down')),
  details text not null default '',
  created_at timestamptz not null default now()
);

alter table public.tags enable row level security;
alter table public.projects enable row level security;
alter table public.tasks enable row level security;
alter table public.issues enable row level security;
alter table public.agents enable row level security;
alter table public.calendar_events enable row level security;

drop policy if exists "tags owner access" on public.tags;
create policy "tags owner access" on public.tags
for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "projects owner access" on public.projects;
create policy "projects owner access" on public.projects
for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "tasks owner access" on public.tasks;
create policy "tasks owner access" on public.tasks
for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "issues owner access" on public.issues;
create policy "issues owner access" on public.issues
for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "agents owner access" on public.agents;
create policy "agents owner access" on public.agents
for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "calendar owner access" on public.calendar_events;
create policy "calendar owner access" on public.calendar_events
for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
