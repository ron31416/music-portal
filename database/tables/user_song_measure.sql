do $$begin raise exception 'do not run this file'; end$$;


--drop table public.song
create table public.user_song_measure (
  user_song_measure_id  int         generated always as identity,
  user_id               int         not null,
  song_id               int         not null,
  measure_number        smallint    not null,
  annotations_json      jsonb       not null,
  inserted_datetime     timestamptz not null default now(),
  updated_datetime      timestamptz not null default now(),
  constraint pk_user_song_measure primary key (
    user_song_measure_id
  ),
  constraint uk00_user_song_measure unique (
    user_id,
    song_id,
    measure_number
  ),
  constraint fk00_user_song_measure foreign key (
    user_id,
    song_id
  )
    references public.user_song (
      user_id,
      song_id
    )
);

