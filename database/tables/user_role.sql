do $$begin raise exception 'do not run this file'; end$$;


--drop table public.user_role;
create table public.user_role (
  user_role_id      int         generated always as identity,
  user_role_number  int         not null,
  user_role_name    text        not null,
  inserted_datetime timestamptz not null default now(),
  updated_datetime  timestamptz not null default now(),
  constraint pk_user_role primary key (
    user_role_id
  ),
  constraint uk00_user_role unique (
    user_role_number
  ),
  constraint uk01_user_role unique (
    user_role_name
  )
);

insert into public.user_role (user_role_number, user_role_name) values (1, 'Admin');
insert into public.user_role (user_role_number, user_role_name) values (2, 'Student');
insert into public.user_role (user_role_number, user_role_name) values (3, 'Guest');

