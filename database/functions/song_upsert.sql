do $$begin raise exception 'do not run this file'; end$$;


--drop function public.song_upsert(int,text,text,text,int,text,bytea)
create function public.song_upsert(
    p_song_id               int,
    p_song_title            text,
    p_composer_first_name   text,
    p_composer_last_name    text,
    p_skill_level_number    int,
    p_file_name             text,
    p_song_mxl              bytea
)
returns int
language plpgsql
as $$
declare
    v_song_id int;
begin
    IF p_song_id is null then
        insert into public.song (
            song_title,
            composer_first_name,
            composer_last_name,
            skill_level_number,
            file_name,
            song_mxl
        )
        values (
            p_song_title,
            p_composer_first_name,
            p_composer_last_name,
            p_skill_level_number,
            p_file_name,
            p_song_mxl
        )
        returning song_id into v_song_id;
        return v_song_id;
    else
        update public.song
        set
            song_title           = p_song_title,
            composer_first_name  = p_composer_first_name,
            composer_last_name   = p_composer_last_name,
            skill_level_number   = p_skill_level_number,
            file_name            = p_file_name,
            song_mxl             = p_song_mxl,
            updated_datetime     = now()
        where song_id = p_song_id;
        if found then
            return p_song_id;
        else
            raise exception 'song_id % not found', p_song_id
               using errcode = 'P0002';  -- no_data_found
        end if;
    end if;
end
$$;

revoke all on function public.song_upsert(int, text, text, text, int, text, bytea)
  from public, authenticated, anon;
grant execute on function public.song_upsert(int, text, text, text, int, text, bytea)
  to service_role;

