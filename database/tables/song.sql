do $$begin raise exception 'do not run this file'; end$$;


--drop table public.song
create table public.song (
  song_id             int         generated always as identity,
  composer_first_name text        not null,
  composer_last_name  text        not null,
  song_title          text        not null,
  skill_level_number  int         not null,
  file_name           text        not null,
  song_mxl            bytea       not null,
  inserted_datetime   timestamptz not null default now(),
  updated_datetime    timestamptz not null default now(),
  constraint pk_song primary key (
    song_id
  ),
  constraint uk00_song unique (
    composer_first_name,
    composer_last_name,
    song_title,
    skill_level_number
  ),
  constraint uk01_song unique (
    file_name
  ),
  constraint fk00_song foreign key (
    skill_level_number
  )
    references public.skill_level (
      skill_level_number
    ),
  constraint ck00_song check (
    substring(song_mxl from 1 for 4)
      IN (E'\\x504b0304'::bytea, E'\\x504b0506'::bytea, E'\\x504b0708'::bytea)
  )
);

