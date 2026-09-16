-- Orbit Supabase 初始化脚本
-- 在 Supabase SQL Editor 中完整执行一次。重复执行是安全的。

create extension if not exists pgcrypto;

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default '未命名应用' check (char_length(title) between 1 and 80),
  summary text not null default '' check (char_length(summary) <= 240),
  current_version_id uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.code_versions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  version_number integer not null check (version_number > 0),
  title text not null check (char_length(title) between 1 and 80),
  summary text not null check (char_length(summary) between 1 and 240),
  html text not null check (char_length(html) between 300 and 120000),
  created_at timestamptz not null default now(),
  unique (project_id, version_number)
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'projects_current_version_id_fkey'
  ) then
    alter table public.projects
      add constraint projects_current_version_id_fkey
      foreign key (current_version_id) references public.code_versions(id) on delete set null;
  end if;
end $$;

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(content) between 1 and 4000),
  created_at timestamptz not null default now()
);

create index if not exists projects_user_updated_idx on public.projects (user_id, updated_at desc);
create index if not exists messages_project_created_idx on public.messages (project_id, created_at asc);
create index if not exists versions_project_number_idx on public.code_versions (project_id, version_number desc);

alter table public.projects enable row level security;
alter table public.messages enable row level security;
alter table public.code_versions enable row level security;

revoke all on public.projects, public.messages, public.code_versions from anon;
revoke all on public.projects, public.messages, public.code_versions from authenticated;
grant select, insert, update, delete on public.projects to authenticated;
grant select, insert on public.messages to authenticated;
grant select, insert on public.code_versions to authenticated;

drop policy if exists "projects_select_own" on public.projects;
create policy "projects_select_own" on public.projects for select to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

drop policy if exists "projects_insert_own" on public.projects;
create policy "projects_insert_own" on public.projects for insert to authenticated
  with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);

drop policy if exists "projects_update_own" on public.projects;
create policy "projects_update_own" on public.projects for update to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and (
      current_version_id is null
      or exists (
        select 1 from public.code_versions v
        where v.id = current_version_id
          and v.project_id = projects.id
          and v.user_id = (select auth.uid())
      )
    )
  );

drop policy if exists "projects_delete_own" on public.projects;
create policy "projects_delete_own" on public.projects for delete to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "messages_select_own" on public.messages;
create policy "messages_select_own" on public.messages for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "messages_insert_own" on public.messages;
create policy "messages_insert_own" on public.messages for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.projects p
      where p.id = project_id and p.user_id = (select auth.uid())
    )
  );

drop policy if exists "versions_select_own" on public.code_versions;
create policy "versions_select_own" on public.code_versions for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "versions_insert_own" on public.code_versions;
create policy "versions_insert_own" on public.code_versions for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.projects p
      where p.id = project_id and p.user_id = (select auth.uid())
    )
  );

create or replace function public.save_generation(
  p_project_id uuid,
  p_user_message text,
  p_title text,
  p_summary text,
  p_html text,
  p_assistant_message text
)
returns table (project_id uuid, version_id uuid, version_number integer)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_project_id uuid;
  v_version_id uuid;
  v_version_number integer;
begin
  if v_user_id is null then raise exception 'authentication required'; end if;
  if char_length(p_user_message) not between 3 and 2000 then raise exception 'invalid prompt length'; end if;
  if char_length(p_title) not between 1 and 80 then raise exception 'invalid title length'; end if;
  if char_length(p_summary) not between 1 and 240 then raise exception 'invalid summary length'; end if;
  if char_length(p_html) not between 300 and 120000 then raise exception 'invalid html length'; end if;

  if p_project_id is null then
    insert into public.projects (user_id, title, summary)
    values (v_user_id, p_title, p_summary)
    returning id into v_project_id;
  else
    select id into v_project_id
    from public.projects
    where id = p_project_id and user_id = v_user_id
    for update;
    if v_project_id is null then raise exception 'project not found'; end if;
  end if;

  select coalesce(max(v.version_number), 0) + 1 into v_version_number
  from public.code_versions v where v.project_id = v_project_id;

  insert into public.messages (project_id, user_id, role, content)
  values
    (v_project_id, v_user_id, 'user', p_user_message),
    (v_project_id, v_user_id, 'assistant', p_assistant_message);

  insert into public.code_versions (project_id, user_id, version_number, title, summary, html)
  values (v_project_id, v_user_id, v_version_number, p_title, p_summary, p_html)
  returning id into v_version_id;

  update public.projects
  set title = p_title,
      summary = p_summary,
      current_version_id = v_version_id,
      updated_at = now()
  where id = v_project_id;

  return query select v_project_id, v_version_id, v_version_number;
end;
$$;

create or replace function public.restore_version(p_project_id uuid, p_version_id uuid)
returns table (
  version_id uuid,
  version_number integer,
  title text,
  summary text,
  html text
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_version public.code_versions%rowtype;
begin
  if v_user_id is null then raise exception 'authentication required'; end if;

  perform 1 from public.projects
  where id = p_project_id and user_id = v_user_id
  for update;
  if not found then raise exception 'project not found'; end if;

  select * into v_version from public.code_versions
  where id = p_version_id and project_id = p_project_id and user_id = v_user_id;
  if not found then raise exception 'version not found'; end if;

  update public.projects
  set title = v_version.title,
      summary = v_version.summary,
      current_version_id = v_version.id,
      updated_at = now()
  where id = p_project_id;

  insert into public.messages (project_id, user_id, role, content)
  values (p_project_id, v_user_id, 'assistant', format('已恢复到版本 %s。', v_version.version_number));

  return query select v_version.id, v_version.version_number, v_version.title, v_version.summary, v_version.html;
end;
$$;

revoke all on function public.save_generation(uuid, text, text, text, text, text) from public, anon;
revoke all on function public.restore_version(uuid, uuid) from public, anon;
grant execute on function public.save_generation(uuid, text, text, text, text, text) to authenticated;
grant execute on function public.restore_version(uuid, uuid) to authenticated;

\n