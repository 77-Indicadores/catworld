ALTER TABLE dbo.cw_dataset_sources ADD refresh_cron VARCHAR(100) NULL;

-- Hourly: a cada 2h das 7h às 19h UTC
UPDATE dbo.cw_dataset_sources
SET refresh_cron = '0 7-19/2 * * *'
WHERE refresh_policy = 'hourly' AND active = 1;

-- Daily: distribuído via hash do ID entre 04:00 e 06:59 UTC (estilo Jenkins H)
WITH hashed AS (
  SELECT id,
    ABS(CHECKSUM(CONVERT(nvarchar(36), id))) % 180 AS offset_min
  FROM dbo.cw_dataset_sources
  WHERE refresh_policy = 'daily' AND active = 1
)
UPDATE s
SET s.refresh_cron = CONCAT(
  CAST(h.offset_min % 60 AS VARCHAR(2)),
  ' ',
  CAST(4 + h.offset_min / 60 AS VARCHAR(1)),
  ' * * *'
)
FROM dbo.cw_dataset_sources s
JOIN hashed h ON s.id = h.id;

ALTER TABLE dbo.cw_dataset_sources DROP COLUMN refresh_policy;
ALTER TABLE dbo.cw_dataset_sources DROP COLUMN refresh_hour;
ALTER TABLE dbo.cw_dataset_sources DROP COLUMN refresh_weekday;
