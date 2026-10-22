create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Player' check (length(display_name) between 1 and 40),
  avatar_url text,
  created_at timestamptz not null default now()
);

create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 2 and 48),
  tag text not null default '' check (length(tag) <= 8),
  description text not null default '' check (length(description) <= 500),
  region text not null default 'Europe' check (length(region) <= 32),
  timezone text not null default 'UTC' check (length(timezone) <= 64),
  logo_url text,
  join_code_hash text not null unique check (join_code_hash ~ '^[a-f0-9]{64}$'),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
alter table public.teams add column if not exists timezone text not null default 'UTC';

create table if not exists public.team_memberships (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  user_id uuid not null constraint team_memberships_profile_fkey references public.profiles(id) on delete cascade,
  role text not null default 'tryout'
    check (role in ('main_roster', 'main_substitute', 'substitute', 'tryout', 'coach')),
  is_admin boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  unique (team_id, user_id)
);

create index if not exists team_memberships_user_status_idx
  on public.team_memberships (user_id, status);
create index if not exists team_memberships_team_status_idx
  on public.team_memberships (team_id, status);

create table if not exists public.team_availability (
  team_id uuid not null references public.teams(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  slot_index smallint not null check (slot_index between 0 and 167),
  available boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (team_id, user_id, slot_index)
);

create table if not exists public.chat_channels (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references public.teams(id) on delete cascade,
  name text not null check (length(name) between 2 and 48),
  kind text not null check (kind in ('global', 'team', 'main', 'custom')),
  allowed_roles text[] not null default '{}',
  allowed_user_ids uuid[] not null default '{}',
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  check ((kind = 'global' and team_id is null) or (kind <> 'global' and team_id is not null))
);

create unique index if not exists one_english_global_chat
  on public.chat_channels (kind) where kind = 'global';

insert into public.chat_channels (name, kind)
values ('English · Global', 'global')
on conflict (kind) where kind = 'global' do nothing;

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.chat_channels(id) on delete cascade,
  author_id uuid not null constraint chat_messages_author_profile_fkey references public.profiles(id) on delete cascade,
  body text not null check (length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_channel_created_idx
  on public.chat_messages (channel_id, created_at desc);
create index if not exists chat_messages_author_created_idx
  on public.chat_messages (author_id, created_at desc);

create table if not exists public.coach_posts (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  author_id uuid not null constraint coach_posts_author_profile_fkey references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('feedback', 'vod')),
  title text not null check (length(title) between 2 and 100),
  body text not null default '' check (length(body) <= 4000),
  vod_url text,
  created_at timestamptz not null default now(),
  check ((kind = 'vod' and vod_url ~ '^https://') or kind = 'feedback')
);

create index if not exists coach_posts_team_created_idx
  on public.coach_posts (team_id, created_at desc);

insert into public.profiles (id, display_name)
select u.id, coalesce(
  nullif(left(trim(coalesce(u.raw_user_meta_data ->> 'display_name', '')), 40), ''),
  nullif(left(split_part(coalesce(u.email, ''), '@', 1), 40), ''),
  'Player'
)
from auth.users u
on conflict (id) do nothing;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'team_memberships_profile_fkey' and conrelid = 'public.team_memberships'::regclass) then
    alter table public.team_memberships
      add constraint team_memberships_profile_fkey foreign key (user_id)
      references public.profiles(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chat_messages_author_profile_fkey' and conrelid = 'public.chat_messages'::regclass) then
    alter table public.chat_messages
      add constraint chat_messages_author_profile_fkey foreign key (author_id)
      references public.profiles(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'coach_posts_author_profile_fkey' and conrelid = 'public.coach_posts'::regclass) then
    alter table public.coach_posts
      add constraint coach_posts_author_profile_fkey foreign key (author_id)
      references public.profiles(id) on delete cascade;
  end if;
end;
$$;

create or replace function public.is_team_admin(p_team_id uuid)
returns boolean
language sql stable security definer
set search_path = public, extensions, pg_temp
as $$
  select exists (
    select 1 from public.team_memberships m
    where m.team_id = p_team_id and m.user_id = auth.uid()
      and m.status = 'approved' and m.is_admin
  );
$$;

create or replace function public.is_approved_team_member(p_team_id uuid)
returns boolean
language sql stable security definer
set search_path = public, extensions, pg_temp
as $$
  select exists (
    select 1 from public.team_memberships m
    where m.team_id = p_team_id and m.user_id = auth.uid() and m.status = 'approved'
  );
$$;

create or replace function public.can_view_team(p_team_id uuid)
returns boolean
language sql stable security definer
set search_path = public, extensions, pg_temp
as $$
  select exists (
    select 1 from public.team_memberships m
    where m.team_id = p_team_id and m.user_id = auth.uid()
  );
$$;

create or replace function public.can_access_channel(p_channel_id uuid)
returns boolean
language sql stable security definer
set search_path = public, extensions, pg_temp
as $$
  select exists (
    select 1
    from public.chat_channels c
    where c.id = p_channel_id and (
      (c.kind = 'global' and auth.uid() is not null)
      or exists (
        select 1
        from public.team_memberships m
        where m.team_id = c.team_id and m.user_id = auth.uid()
          and m.status = 'approved'
          and (
            m.is_admin
            or (c.kind = 'team' and m.role <> 'tryout')
            or (c.kind = 'main' and m.role in ('main_roster', 'coach'))
            or (c.kind = 'custom' and (
              m.role = any(c.allowed_roles) or auth.uid() = any(c.allowed_user_ids)
            ))
          )
      )
    )
  );
$$;

create or replace function public.create_team(
  p_name text,
  p_tag text,
  p_description text,
  p_region text,
  p_timezone text,
  p_join_code text
)
returns uuid
language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  new_team_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in before creating a team.'; end if;
  if length(trim(p_name)) not between 2 and 48 then raise exception 'Team name must be 2 to 48 characters.'; end if;
  if p_join_code !~ '^[A-Za-z0-9_-]{32}$' then raise exception 'Team code is invalid.'; end if;

  insert into public.teams (name, tag, description, region, timezone, join_code_hash, created_by)
  values (trim(p_name), coalesce(trim(p_tag), ''), coalesce(trim(p_description), ''),
          coalesce(trim(p_region), 'Europe'), coalesce(trim(p_timezone), 'UTC'),
          encode(digest(p_join_code, 'sha256'), 'hex'), auth.uid())
  returning id into new_team_id;

  insert into public.team_memberships (team_id, user_id, role, is_admin, status)
  values (new_team_id, auth.uid(), 'main_roster', true, 'approved');
  insert into public.chat_channels (team_id, name, kind, created_by)
  values
    (new_team_id, 'Team chat', 'team', auth.uid()),
    (new_team_id, 'Main roster', 'main', auth.uid());
  return new_team_id;
end;
$$;

create or replace function public.request_team_join(p_join_code text)
returns table (team_id uuid, team_name text)
language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  found_team public.teams%rowtype;
  existing_membership public.team_memberships%rowtype;
begin
  if auth.uid() is null then raise exception 'Sign in before joining a team.'; end if;
  if p_join_code !~ '^[A-Za-z0-9_-]{32}$' then raise exception 'Enter a valid 32-character team code.'; end if;

  select * into found_team from public.teams t
  where t.join_code_hash = encode(digest(p_join_code, 'sha256'), 'hex');
  if not found then raise exception 'Team code not found. Check the code and try again.'; end if;
  select * into existing_membership from public.team_memberships m
  where m.team_id = found_team.id and m.user_id = auth.uid() for update;
  if found and existing_membership.status in ('pending', 'approved') then
    raise exception 'You already have a request or membership for this team.';
  elsif found then
    update public.team_memberships set status = 'pending', role = 'tryout', is_admin = false
    where id = existing_membership.id;
    return query select found_team.id, found_team.name;
    return;
  end if;

  insert into public.team_memberships (team_id, user_id, role, status)
  values (found_team.id, auth.uid(), 'tryout', 'pending');
  return query select found_team.id, found_team.name;
end;
$$;

create or replace function public.regenerate_team_code(p_team_id uuid, p_join_code text)
returns void
language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if not public.is_team_admin(p_team_id) then raise exception 'Only team admins can generate a team code.'; end if;
  if p_join_code !~ '^[A-Za-z0-9_-]{32}$' then raise exception 'Team code is invalid.'; end if;
  update public.teams set join_code_hash = encode(digest(p_join_code, 'sha256'), 'hex')
  where id = p_team_id;
end;
$$;

create or replace function public.set_membership_status(p_membership_id uuid, p_status text)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  target public.team_memberships%rowtype;
begin
  if p_status not in ('approved', 'rejected') then raise exception 'Invalid membership decision.'; end if;
  select * into target from public.team_memberships where id = p_membership_id for update;
  if not found or not public.is_team_admin(target.team_id) then raise exception 'Only a team admin can review join requests.'; end if;
  if target.status <> 'pending' then raise exception 'This request has already been reviewed.'; end if;
  update public.team_memberships set status = p_status where id = p_membership_id;
end;
$$;

create or replace function public.set_member_access(p_membership_id uuid, p_role text, p_is_admin boolean)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  target public.team_memberships%rowtype;
begin
  if p_role not in ('main_roster', 'main_substitute', 'substitute', 'tryout', 'coach') then
    raise exception 'Select a valid team role.';
  end if;
  select * into target from public.team_memberships where id = p_membership_id for update;
  if not found or not public.is_team_admin(target.team_id) then raise exception 'Only a team admin can manage roles.'; end if;
  if target.status <> 'approved' then raise exception 'Approve the member before changing their role.'; end if;
  if target.user_id = auth.uid() and target.is_admin and not p_is_admin and
     (select count(*) from public.team_memberships m where m.team_id = target.team_id and m.status = 'approved' and m.is_admin) <= 1 then
    raise exception 'A team must keep at least one admin.';
  end if;
  update public.team_memberships set role = p_role, is_admin = p_is_admin where id = p_membership_id;
end;
$$;

create or replace function public.create_custom_channel(
  p_team_id uuid,
  p_name text,
  p_allowed_roles text[],
  p_allowed_user_ids uuid[]
)
returns uuid
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  new_channel_id uuid;
begin
  if not public.is_team_admin(p_team_id) then raise exception 'Only team admins can create custom chats.'; end if;
  if length(trim(p_name)) not between 2 and 48 then raise exception 'Chat name must be 2 to 48 characters.'; end if;
  if exists (select 1 from unnest(coalesce(p_allowed_roles, '{}')) r
            where r not in ('main_roster', 'main_substitute', 'substitute', 'tryout', 'coach')) then
    raise exception 'A selected role is invalid.';
  end if;
  insert into public.chat_channels (team_id, name, kind, allowed_roles, allowed_user_ids, created_by)
  values (p_team_id, trim(p_name), 'custom', coalesce(p_allowed_roles, '{}'),
          coalesce(p_allowed_user_ids, '{}'), auth.uid())
  returning id into new_channel_id;
  return new_channel_id;
end;
$$;

create or replace function public.create_profile_for_new_user()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(
      nullif(left(trim(coalesce(new.raw_user_meta_data ->> 'display_name', '')), 40), ''),
      nullif(left(split_part(coalesce(new.email, ''), '@', 1), 40), ''),
      'Player'
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists create_profile_after_signup on auth.users;
create trigger create_profile_after_signup
  after insert on auth.users
  for each row execute procedure public.create_profile_for_new_user();

alter table public.profiles enable row level security;
alter table public.teams enable row level security;
alter table public.team_memberships enable row level security;
alter table public.team_availability enable row level security;
alter table public.chat_channels enable row level security;
alter table public.chat_messages enable row level security;
alter table public.coach_posts enable row level security;

drop policy if exists "Authenticated users can read profiles" on public.profiles;
create policy "Authenticated users can read profiles" on public.profiles
  for select to authenticated using (true);
drop policy if exists "Users can create their own profile" on public.profiles;
create policy "Users can create their own profile" on public.profiles
  for insert to authenticated with check (id = auth.uid());
drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "Members can view their teams" on public.teams;
create policy "Members can view their teams" on public.teams
  for select to authenticated using (public.can_view_team(id));
drop policy if exists "Team admins can update teams" on public.teams;
create policy "Team admins can update teams" on public.teams
  for update to authenticated using (public.is_team_admin(id)) with check (public.is_team_admin(id));

revoke all on public.profiles, public.teams, public.team_memberships, public.chat_channels,
  public.team_availability, public.chat_messages, public.coach_posts from anon, authenticated;
grant select, insert, update on public.profiles to authenticated;
grant select (id, name, tag, description, region, timezone, logo_url, created_by, created_at)
  on public.teams to authenticated;
grant update (name, tag, description, region, logo_url) on public.teams to authenticated;
grant select on public.team_memberships, public.team_availability, public.chat_channels, public.chat_messages, public.coach_posts to authenticated;
grant insert, update on public.team_availability to authenticated;
grant insert on public.chat_messages, public.coach_posts to authenticated;
grant delete on public.chat_channels to authenticated;

drop policy if exists "Members can see their own or pending team memberships" on public.team_memberships;
create policy "Members can see their own or pending team memberships" on public.team_memberships
  for select to authenticated using (user_id = auth.uid() or public.is_team_admin(team_id));

drop policy if exists "Team members can view team availability" on public.team_availability;
create policy "Team members can view team availability" on public.team_availability
  for select to authenticated using (public.is_approved_team_member(team_id));
drop policy if exists "Members can set their own availability" on public.team_availability;
create policy "Members can set their own availability" on public.team_availability
  for insert to authenticated with check (user_id = auth.uid() and public.is_approved_team_member(team_id));
drop policy if exists "Members can update their own availability" on public.team_availability;
create policy "Members can update their own availability" on public.team_availability
  for update to authenticated using (user_id = auth.uid() and public.is_approved_team_member(team_id))
  with check (user_id = auth.uid() and public.is_approved_team_member(team_id));

drop policy if exists "Members can view accessible chat channels" on public.chat_channels;
create policy "Members can view accessible chat channels" on public.chat_channels
  for select to authenticated using (public.can_access_channel(id));
drop policy if exists "Admins can delete custom channels" on public.chat_channels;
create policy "Admins can delete custom channels" on public.chat_channels
  for delete to authenticated using (kind = 'custom' and public.is_team_admin(team_id));

drop policy if exists "Members can read accessible chat messages" on public.chat_messages;
create policy "Members can read accessible chat messages" on public.chat_messages
  for select to authenticated using (public.can_access_channel(channel_id));
drop policy if exists "Members can post in accessible chats" on public.chat_messages;
create policy "Members can post in accessible chats" on public.chat_messages
  for insert to authenticated with check (author_id = auth.uid() and public.can_access_channel(channel_id));

drop policy if exists "Team members can read coach hub posts" on public.coach_posts;
create policy "Team members can read coach hub posts" on public.coach_posts
  for select to authenticated using (public.is_approved_team_member(team_id));
drop policy if exists "Eligible team roles can post feedback and VODs" on public.coach_posts;
create policy "Eligible team roles can post feedback and VODs" on public.coach_posts
  for insert to authenticated with check (
    author_id = auth.uid() and public.is_approved_team_member(team_id) and
    (
      public.is_team_admin(team_id)
      or (kind = 'feedback' and exists (
        select 1 from public.team_memberships m
        where m.team_id = coach_posts.team_id and m.user_id = auth.uid() and m.status = 'approved' and m.role = 'coach'
      ))
      or (kind = 'vod' and exists (
        select 1 from public.team_memberships m
        where m.team_id = coach_posts.team_id and m.user_id = auth.uid() and m.status = 'approved'
          and m.role in ('main_roster', 'main_substitute')
      ))
    )
  );

revoke all on function public.create_profile_for_new_user() from anon, authenticated;

revoke all on function public.is_team_admin(uuid), public.is_approved_team_member(uuid),
  public.can_view_team(uuid), public.can_access_channel(uuid) from public, anon;
grant execute on function public.is_team_admin(uuid), public.is_approved_team_member(uuid),
  public.can_view_team(uuid), public.can_access_channel(uuid) to authenticated;

revoke all on function public.create_team(text, text, text, text, text, text) from public;
grant execute on function public.create_team(text, text, text, text, text, text) to authenticated;
revoke all on function public.request_team_join(text) from public;
grant execute on function public.request_team_join(text) to authenticated;
revoke all on function public.regenerate_team_code(uuid, text) from public;
grant execute on function public.regenerate_team_code(uuid, text) to authenticated;
revoke all on function public.set_membership_status(uuid, text) from public;
grant execute on function public.set_membership_status(uuid, text) to authenticated;
revoke all on function public.set_member_access(uuid, text, boolean) from public;
grant execute on function public.set_member_access(uuid, text, boolean) to authenticated;
revoke all on function public.create_custom_channel(uuid, text, text[], uuid[]) from public;
grant execute on function public.create_custom_channel(uuid, text, text[], uuid[]) to authenticated;

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'team_memberships') then
    alter publication supabase_realtime add table public.team_memberships;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'team_availability') then
    alter publication supabase_realtime add table public.team_availability;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chat_messages') then
    alter publication supabase_realtime add table public.chat_messages;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'coach_posts') then
    alter publication supabase_realtime add table public.coach_posts;
  end if;
end;
$$;

create or replace function public.enforce_chat_cooldown()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.author_id::text, 0));
  if exists (
    select 1 from public.chat_messages m
    where m.author_id = new.author_id and m.created_at > now() - interval '2 seconds'
  ) then
    raise exception 'Please wait a moment before sending another message.';
  end if;
  return new;
end;
$$;

drop trigger if exists chat_messages_cooldown on public.chat_messages;
create trigger chat_messages_cooldown
  before insert on public.chat_messages
  for each row execute procedure public.enforce_chat_cooldown();
revoke all on function public.enforce_chat_cooldown() from public, anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('team-logos', 'team-logos', true, 5242880, array['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
on conflict (id) do update set public = true, file_size_limit = 5242880,
  allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

drop policy if exists "Team logos are public" on storage.objects;
create policy "Team logos are public" on storage.objects
  for select to public using (bucket_id = 'team-logos');
drop policy if exists "Team admins upload team logos" on storage.objects;
create policy "Team admins upload team logos" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'team-logos' and exists (
      select 1 from public.teams t
      where t.id::text = (storage.foldername(name))[1] and public.is_team_admin(t.id)
    )
  );
drop policy if exists "Team admins update team logos" on storage.objects;
create policy "Team admins update team logos" on storage.objects
  for update to authenticated using (
    bucket_id = 'team-logos' and exists (
      select 1 from public.teams t
      where t.id::text = (storage.foldername(name))[1] and public.is_team_admin(t.id)
    )
  ) with check (
    bucket_id = 'team-logos' and exists (
      select 1 from public.teams t
      where t.id::text = (storage.foldername(name))[1] and public.is_team_admin(t.id)
    )
  );
