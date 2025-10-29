do $$begin raise exception 'do not run this file'; end$$;


--drop table public.song
create table public.user_song (
  user_song_id        int         generated always as identity,
  user_id             int         not null,
  song_id             int         not null,
  inserted_datetime   timestamptz not null default now(),
  updated_datetime    timestamptz not null default now(),
  constraint pk_user_song primary key (
    user_song_id
  ),
  constraint uk00_user_song unique (
    user_id,
    song_id
  ),
  constraint fk00_user_song foreign key (
    user_id
  )
    references public.site_user (
      user_id
    ),
  constraint fk01_user_song foreign key (
    song_id
  )
    references public.song (
      song_id
    )
);

