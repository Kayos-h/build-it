-- Additive, app-specific schema. Existing application tables are untouched.
create table public.buildit_users (
 id integer generated always as identity primary key,
 email text not null unique check (email = lower(email)), password_hash text not null,
 role text not null default 'user' check (role in ('admin','user')),
 expires_at timestamptz, force_password_reset boolean not null default false,
 session_version integer not null default 0,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.buildit_models (
 id text primary key, kind text not null check(kind in ('case','motherboard','cpu','cooler','ram','gpu','psu','ssd','fan')),
 name text not null, detail text not null, model_path text not null unique,
 power_watts double precision not null default 0, metadata jsonb not null default '{}',
 transform jsonb not null default '{"position":[0,0,0],"rotation":[0,0,0],"scale":[1,1,1]}',
 bounds jsonb, is_builtin boolean not null default false,
 created_by integer references public.buildit_users(id) on delete set null,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.buildit_permissions (
 user_id integer references public.buildit_users(id) on delete cascade,
 model_id text references public.buildit_models(id) on delete cascade,
 granted_by integer references public.buildit_users(id) on delete set null,
 created_at timestamptz not null default now(), primary key(user_id,model_id)
);
create table public.buildit_drafts (
 id uuid primary key, user_id integer not null references public.buildit_users(id) on delete cascade,
 name text not null, state jsonb not null, revision integer not null default 1,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index buildit_drafts_owner on public.buildit_drafts(user_id,updated_at);
create function public.buildit_bump_session() returns trigger language plpgsql set search_path = public as $$
begin
 if new.password_hash is distinct from old.password_hash or new.role is distinct from old.role
   or new.force_password_reset is distinct from old.force_password_reset then
   new.session_version := old.session_version + 1;
 end if;
 return new;
end $$;
create trigger buildit_session_update before update on public.buildit_users
for each row execute function public.buildit_bump_session();
create function public.buildit_replace_permissions(target_user integer, models text[], actor integer)
returns void language plpgsql set search_path = public as $$
begin
 perform id from buildit_users where id=target_user for update;
 delete from buildit_permissions where user_id=target_user;
 insert into buildit_permissions(user_id,model_id,granted_by)
 select target_user, unnest(models), actor;
end $$;
create function public.buildit_merge_model_metadata(model_id text, patch jsonb)
returns void language sql set search_path = public as $$
 update buildit_models set metadata = metadata || patch, updated_at=now() where id=model_id;
$$;
alter table public.buildit_users enable row level security;
alter table public.buildit_models enable row level security;
alter table public.buildit_permissions enable row level security;
alter table public.buildit_drafts enable row level security;
revoke all on public.buildit_users, public.buildit_models, public.buildit_permissions, public.buildit_drafts from anon, authenticated;
grant all on public.buildit_users, public.buildit_models, public.buildit_permissions, public.buildit_drafts to service_role;
grant usage,select on sequence public.buildit_users_id_seq to service_role;
revoke all on function public.buildit_replace_permissions(integer,text[],integer), public.buildit_merge_model_metadata(text,jsonb), public.buildit_bump_session() from public, anon, authenticated;
grant execute on function public.buildit_replace_permissions(integer,text[],integer), public.buildit_merge_model_metadata(text,jsonb) to service_role;
insert into storage.buckets(id,name,public,file_size_limit)
values('buildit-models','buildit-models',false,52428800);
