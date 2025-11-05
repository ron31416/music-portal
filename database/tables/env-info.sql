do $$begin raise exception 'do not run this file'; end$$;


--drop table public.env_info;
create table public.system_environment (
  system_environment_id     int         generated always as identity,
  system_environment_name   text        not null,
  inserted_datetime         timestamptz not null default now(),
  updated_datetime          timestamptz not null default now(),
  constraint pk_system_environment primary key (
    system_environment_id
  ),
  constraint uk01_system_environment unique (
    system_environment_name
  )
);

insert into public.system_environment (system_environment_name) values ('music-portal-dev');

