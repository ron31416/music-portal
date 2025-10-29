do $$begin raise exception 'do not run this file'; end$$;


--drop table public.site_user;
create table public.site_user (
  user_id           int         generated always as identity,
  user_name         text        not null,
  user_email        text        not null,
  user_first_name   text        not null,
  user_last_name    text        not null,
  user_role_number  int         not null,
  inserted_datetime timestamptz not null default now(),
  updated_datetime  timestamptz not null default now(),
  constraint pk_site_user primary key (
    user_id
  ),
  constraint uk00_site_user unique (
    user_name
  ),
  constraint uk01_site_user unique (
    user_email
  ),
  constraint fk00_site_user foreign key (
    user_role_number
  )
    references public.user_role (
      user_role_number
    ),
  constraint ck00_site_user check (
    user_name = lower(user_name)
  ),
  constraint ck01_site_user check (
    length(btrim(user_name)) > 0
  ),
  constraint ck02_site_user check (
    user_email = lower(user_email)
  ),
  constraint ck03_site_user check (
    length(btrim(user_email)) > 0
  ),
  constraint ck04_site_user check (
    user_email ~ '^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$'
  )
);

insert into public.site_user (user_name, user_email, user_first_name, user_last_name, user_role_number)
    values ('ron31416', 'ron31416@gmail.com', 'Ron', 'Rice', 1)

