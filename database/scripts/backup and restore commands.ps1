
.\database\scripts\backup-db.ps1


-- run before and after a test restore
select t.table_name as table,
       (xpath('/row/c/text()', query_to_xml(
          format('select count(*) as c from %I.%I', t.table_schema, t.table_name),
          false, true, '')))[1]::text::bigint as exact_rows
from information_schema.tables t
where t.table_schema = 'public' and t.table_type='BASE TABLE'
order by t.table_name;



$last = Get-ChildItem .\database\scripts\db_backups\backup_*.dump | Sort-Object LastWriteTime -Descending | Select-Object -First 1
.\database\scripts\restore-db.ps1 $last.FullName