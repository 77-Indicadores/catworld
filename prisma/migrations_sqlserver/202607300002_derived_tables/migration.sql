CREATE TABLE dbo.cw_derived_tables (
  id              UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
  dataset_id      UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.cw_datasets(id) ON DELETE CASCADE,
  target_table_id UNIQUEIDENTIFIER NULL UNIQUE REFERENCES dbo.cw_tables(id),
  name            NVARCHAR(255) NOT NULL,
  sql_name        VARCHAR(128) NOT NULL,
  query_sql       NVARCHAR(MAX) NOT NULL,
  refresh_cron    VARCHAR(100) NULL,
  last_status     VARCHAR(32) NULL,
  last_row_count  BIGINT NULL,
  last_error      NVARCHAR(MAX) NULL,
  last_refreshed_at DATETIME2 NULL,
  next_refresh_at DATETIME2 NULL,
  active          BIT NOT NULL DEFAULT 1,
  created_at      DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  updated_at      DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);

CREATE INDEX IX_cw_derived_tables_dataset ON dbo.cw_derived_tables(dataset_id, active);
CREATE INDEX IX_cw_derived_tables_refresh ON dbo.cw_derived_tables(next_refresh_at);
