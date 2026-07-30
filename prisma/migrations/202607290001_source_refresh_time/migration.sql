ALTER TABLE dbo.cw_dataset_sources
  ADD refresh_hour    TINYINT NULL,
      refresh_weekday TINYINT NULL;
