ALTER TABLE [dbo].[cw_connections] ADD
  [provider] VARCHAR(32) NOT NULL CONSTRAINT [cw_connections_provider_df] DEFAULT 'postgres',
  [port] INT NULL,
  [ssl_mode] VARCHAR(32) NOT NULL CONSTRAINT [cw_connections_ssl_mode_df] DEFAULT 'require',
  [metadata_json] NVARCHAR(MAX) NULL;

CREATE TABLE [dbo].[cw_dataset_sources] (
  [id] UNIQUEIDENTIFIER NOT NULL CONSTRAINT [cw_dataset_sources_id_df] DEFAULT NEWID(),
  [dataset_id] UNIQUEIDENTIFIER NOT NULL,
  [connection_id] UNIQUEIDENTIFIER NOT NULL,
  [target_table_id] UNIQUEIDENTIFIER NULL,
  [name] NVARCHAR(255) NOT NULL,
  [mode] VARCHAR(20) NOT NULL,
  [source_kind] VARCHAR(20) NOT NULL,
  [source_schema] NVARCHAR(128) NULL,
  [source_table] NVARCHAR(128) NULL,
  [source_sql] NVARCHAR(MAX) NULL,
  [refresh_policy] VARCHAR(20) NOT NULL CONSTRAINT [cw_dataset_sources_refresh_policy_df] DEFAULT 'manual',
  [last_status] VARCHAR(32) NULL,
  [last_row_count] BIGINT NULL,
  [last_error] NVARCHAR(MAX) NULL,
  [last_refreshed_at] DATETIME2 NULL,
  [next_refresh_at] DATETIME2 NULL,
  [active] BIT NOT NULL CONSTRAINT [cw_dataset_sources_active_df] DEFAULT 1,
  [created_at] DATETIME2 NOT NULL CONSTRAINT [cw_dataset_sources_created_at_df] DEFAULT CURRENT_TIMESTAMP,
  [updated_at] DATETIME2 NOT NULL CONSTRAINT [cw_dataset_sources_updated_at_df] DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT [cw_dataset_sources_pkey] PRIMARY KEY CLUSTERED ([id]),
  CONSTRAINT [cw_dataset_sources_dataset_id_fkey] FOREIGN KEY ([dataset_id]) REFERENCES [dbo].[cw_datasets]([id]) ON DELETE CASCADE,
  CONSTRAINT [cw_dataset_sources_connection_id_fkey] FOREIGN KEY ([connection_id]) REFERENCES [dbo].[cw_connections]([id]),
  CONSTRAINT [cw_dataset_sources_target_table_id_fkey] FOREIGN KEY ([target_table_id]) REFERENCES [dbo].[cw_tables]([id]),
  CONSTRAINT [cw_dataset_sources_target_table_id_key] UNIQUE NONCLUSTERED ([target_table_id])
);

CREATE NONCLUSTERED INDEX [cw_dataset_sources_dataset_id_active_idx] ON [dbo].[cw_dataset_sources]([dataset_id],[active]);
CREATE NONCLUSTERED INDEX [cw_dataset_sources_connection_id_idx] ON [dbo].[cw_dataset_sources]([connection_id]);
CREATE NONCLUSTERED INDEX [cw_dataset_sources_mode_refresh_policy_next_refresh_at_idx] ON [dbo].[cw_dataset_sources]([mode],[refresh_policy],[next_refresh_at]);
