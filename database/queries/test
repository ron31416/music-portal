do $$begin raise exception 'do not run this file'; end$$;


select t.table_name as table,
       (xpath('/row/c/text()', query_to_xml(
          format('select count(*) as c from %I.%I', t.table_schema, t.table_name),
          false, true, '')))[1]::text::bigint as exact_rows
from information_schema.tables t
where t.table_schema = 'public' and t.table_type='BASE TABLE'
order by t.table_name;


select 'site_user'        as table, count(*) from public.site_user
union all
select 'skill_level'      , count(*) from public.skill_level
union all
select 'song'             , count(*) from public.song
union all
select 'user_role'        , count(*) from public.user_role
union all
select 'user_song'        , count(*) from public.user_song
union all
select 'user_song_measure', count(*) from public.user_song_measure;


ANALYZE VERBOSE public;



select relname as table, reltuples::bigint as approx_rows
from pg_class 
where relkind='r' and relnamespace = 'public'::regnamespace
order by 1;


select * from song


select * from public.song_list('file_name','desc');


select preview.user_upsert(null, 'someguy', 'someguy@gmail.com', 'Some', 'Guy', 2);

select * from preview.site_user;

select * from preview.user_list('user_name','asc');

select * from public.song_list('skill_level_number','asc');

select * from public.song_get(2)


select grantee, table_schema, table_name, privilege_type 
from information_schema.table_privileges 
where table_schema in ('public', 'preview', 'production')
and grantee not in ('postgres', 'service_role')

select grantee, routine_schema, routine_name, privilege_type 
from information_schema.routine_privileges 
where routine_schema in ('public','preview', 'production')
and grantee not in ('postgres', 'service_role')


SELECT n.nspname AS schema,
       p.proname AS function,
       pg_get_function_identity_arguments(p.oid) AS args,
       pg_get_functiondef(p.oid) AS definition
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname in ('public', 'preview', 'production')
ORDER BY n.nspname, p.proname
limit 1000;



begin;
insert into production.song (
  song_id,
  song_title,
  composer_first_name,
  composer_last_name,
  skill_level_number,
  file_name,
  song_mxl,
  inserted_datetime,
  updated_datetime
)
  select
    song_id,
    song_title,
    composer_first_name,
    composer_last_name,
    skill_level_number,
    file_name,
    song_mxl,
    inserted_datetime,
    updated_datetime
  from preview.song;

select * from production.song;
rollback;

SELECT setval(
  pg_get_serial_sequence('preview.song', 'song_id'),
  (SELECT MAX(song_id) FROM preview.song)
);

select * from production.song_list('skill_level_number','asc');


select * from preview.song where song_title = 'Musette in D'
select * from public.song where song_title = 'Musette in D'

select song_id, file_name from production.song order by song_id


begin;
SELECT production.song_upsert(
  NULL,                           -- p_song_id (NULL for insert)
  'Sweet Dreams',                 -- p_song_title
  'Pyotr Ilyich',                 -- p_composer_first_name
  'Tchaikovsky',                  -- p_composer_last_name
  2,                              -- p_skill_level_number
  'sweet-dreams-tchaikovsky.mxl', -- p_file_name
  decode('504b0304', 'hex')       -- p_song_mxl 
);
rollback;





SELECT *
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'preview';

SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'preview';


SELECT proname, proargtypes
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public';


select * from preview.user_role_list()

select * from preview.user_role_list()


