// src/lib/types.ts

export type SongListItem = Readonly<{
   song_id: number;
   song_title: string;
   composer_first_name: string;
   composer_last_name: string;
   skill_level_name: string;
   skill_level_number: number;
   file_name: string;
   inserted_datetime: string;
   updated_datetime: string;
}>;

export type SongListResponse = Readonly<{ items: SongListItem[] }>;

export type UserListItem = Readonly<{
   user_id: number;
   user_email: string;
   user_first_name: string;
   user_last_name?: string;
   user_role_number: number;
   user_role_name: string;
   inserted_datetime: string;
   updated_datetime: string;
}>;

export type UserListResponse = Readonly<{ items: UserListItem[] }>;
