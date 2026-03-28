-- Idempotent patch for existing OpenClaw dashboard databases
-- Run this in Supabase SQL Editor.

begin;

-- Add missing resolved_at columns
alter table if exists public.tasks
  add column if not exists resolved_at timestamptz;

alter table if exists public.issues
  add column if not exists resolved_at timestamptz;

-- Backfill resolved timestamps where items are already completed/resolved
update public.tasks
set resolved_at = coalesce(resolved_at, now())
where status = 'Done' and resolved_at is null;

update public.issues
set resolved_at = coalesce(resolved_at, now())
where lane = 'done' and resolved_at is null;

-- Helpful indexes for resolved views grouped by day
create index if not exists idx_tasks_user_resolved_at on public.tasks (user_id, resolved_at desc);
create index if not exists idx_issues_user_resolved_at on public.issues (user_id, resolved_at desc);

commit;
