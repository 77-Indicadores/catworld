BEGIN TRY

BEGIN TRAN;

-- CreateSchema
IF NOT EXISTS (SELECT * FROM sys.schemas WHERE name = N'dbo') EXEC sp_executesql N'CREATE SCHEMA [dbo];';

-- CreateTable
CREATE TABLE [dbo].[cw_users] (
    [id] UNIQUEIDENTIFIER NOT NULL,
    [name] NVARCHAR(160) NOT NULL,
    [email] NVARCHAR(320) NOT NULL,
    [password_hash] NVARCHAR(500) NOT NULL,
    [role] VARCHAR(32) NOT NULL CONSTRAINT [cw_users_role_df] DEFAULT 'VIEWER',
    [active] BIT NOT NULL CONSTRAINT [cw_users_active_df] DEFAULT 1,
    [created_at] DATETIME2 NOT NULL CONSTRAINT [cw_users_created_at_df] DEFAULT CURRENT_TIMESTAMP,
    [updated_at] DATETIME2 NOT NULL,
    CONSTRAINT [cw_users_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [cw_users_email_key] UNIQUE NONCLUSTERED ([email])
);

-- CreateTable
CREATE TABLE [dbo].[cw_projects] (
    [id] UNIQUEIDENTIFIER NOT NULL,
    [name] NVARCHAR(255) NOT NULL,
    [slug] VARCHAR(100) NOT NULL,
    [description] NVARCHAR(1000),
    [active] BIT NOT NULL CONSTRAINT [cw_projects_active_df] DEFAULT 1,
    [created_at] DATETIME2 NOT NULL CONSTRAINT [cw_projects_created_at_df] DEFAULT CURRENT_TIMESTAMP,
    [updated_at] DATETIME2 NOT NULL,
    CONSTRAINT [cw_projects_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [cw_projects_slug_key] UNIQUE NONCLUSTERED ([slug])
);

-- CreateTable
CREATE TABLE [dbo].[cw_datasets] (
    [id] UNIQUEIDENTIFIER NOT NULL,
    [project_id] UNIQUEIDENTIFIER NOT NULL,
    [name] NVARCHAR(255) NOT NULL,
    [slug] VARCHAR(100) NOT NULL,
    [description] NVARCHAR(1000),
    [schema_name] VARCHAR(128) NOT NULL,
    [active] BIT NOT NULL CONSTRAINT [cw_datasets_active_df] DEFAULT 1,
    [created_at] DATETIME2 NOT NULL CONSTRAINT [cw_datasets_created_at_df] DEFAULT CURRENT_TIMESTAMP,
    [updated_at] DATETIME2 NOT NULL,
    CONSTRAINT [cw_datasets_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [cw_datasets_schema_name_key] UNIQUE NONCLUSTERED ([schema_name]),
    CONSTRAINT [cw_datasets_project_id_slug_key] UNIQUE NONCLUSTERED ([project_id],[slug])
);

-- CreateTable
CREATE TABLE [dbo].[cw_tables] (
    [id] UNIQUEIDENTIFIER NOT NULL,
    [dataset_id] UNIQUEIDENTIFIER NOT NULL,
    [name] NVARCHAR(255) NOT NULL,
    [sql_name] VARCHAR(128) NOT NULL,
    [row_count] BIGINT NOT NULL CONSTRAINT [cw_tables_row_count_df] DEFAULT 0,
    [size_bytes] BIGINT NOT NULL CONSTRAINT [cw_tables_size_bytes_df] DEFAULT 0,
    [created_at] DATETIME2 NOT NULL CONSTRAINT [cw_tables_created_at_df] DEFAULT CURRENT_TIMESTAMP,
    [updated_at] DATETIME2 NOT NULL,
    CONSTRAINT [cw_tables_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [cw_tables_dataset_id_sql_name_key] UNIQUE NONCLUSTERED ([dataset_id],[sql_name])
);

-- CreateTable
CREATE TABLE [dbo].[cw_columns] (
    [id] UNIQUEIDENTIFIER NOT NULL,
    [table_id] UNIQUEIDENTIFIER NOT NULL,
    [ordinal] INT NOT NULL,
    [original_name] NVARCHAR(255) NOT NULL,
    [sql_name] VARCHAR(128) NOT NULL,
    [sql_type] VARCHAR(100) NOT NULL,
    [nullable] BIT NOT NULL CONSTRAINT [cw_columns_nullable_df] DEFAULT 1,
    CONSTRAINT [cw_columns_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [cw_columns_table_id_sql_name_key] UNIQUE NONCLUSTERED ([table_id],[sql_name])
);

-- CreateTable
CREATE TABLE [dbo].[cw_tokens] (
    [id] UNIQUEIDENTIFIER NOT NULL,
    [name] NVARCHAR(160) NOT NULL,
    [prefix] VARCHAR(24) NOT NULL,
    [token_hash] CHAR(64) NOT NULL,
    [active] BIT NOT NULL CONSTRAINT [cw_tokens_active_df] DEFAULT 1,
    [expires_at] DATETIME2,
    [last_used_at] DATETIME2,
    [created_at] DATETIME2 NOT NULL CONSTRAINT [cw_tokens_created_at_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [cw_tokens_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [cw_tokens_prefix_key] UNIQUE NONCLUSTERED ([prefix]),
    CONSTRAINT [cw_tokens_token_hash_key] UNIQUE NONCLUSTERED ([token_hash])
);

-- CreateTable
CREATE TABLE [dbo].[cw_database_users] (
    [id] UNIQUEIDENTIFIER NOT NULL,
    [name] VARCHAR(128) NOT NULL,
    [kind] VARCHAR(32) NOT NULL,
    [encrypted_password] NVARCHAR(1000) NOT NULL,
    [active] BIT NOT NULL CONSTRAINT [cw_database_users_active_df] DEFAULT 1,
    [last_used_at] DATETIME2,
    [created_at] DATETIME2 NOT NULL CONSTRAINT [cw_database_users_created_at_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [cw_database_users_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [cw_database_users_name_key] UNIQUE NONCLUSTERED ([name])
);

-- CreateTable
CREATE TABLE [dbo].[cw_access_grants] (
    [id] UNIQUEIDENTIFIER NOT NULL,
    [user_id] UNIQUEIDENTIFIER,
    [token_id] UNIQUEIDENTIFIER,
    [database_user_id] UNIQUEIDENTIFIER,
    [scope_type] VARCHAR(20) NOT NULL,
    [project_id] UNIQUEIDENTIFIER,
    [dataset_id] UNIQUEIDENTIFIER,
    [permission] VARCHAR(20) NOT NULL,
    [created_at] DATETIME2 NOT NULL CONSTRAINT [cw_access_grants_created_at_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [cw_access_grants_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[cw_connections] (
    [id] UNIQUEIDENTIFIER NOT NULL,
    [name] NVARCHAR(120) NOT NULL,
    [environment] VARCHAR(32) NOT NULL,
    [server] NVARCHAR(255) NOT NULL,
    [database_name] NVARCHAR(128) NOT NULL,
    [username] NVARCHAR(255) NOT NULL,
    [encrypted_credentials] NVARCHAR(2000) NOT NULL,
    [active] BIT NOT NULL CONSTRAINT [cw_connections_active_df] DEFAULT 1,
    [last_status] VARCHAR(32),
    [last_latency_ms] INT,
    [last_checked_at] DATETIME2,
    [created_at] DATETIME2 NOT NULL CONSTRAINT [cw_connections_created_at_df] DEFAULT CURRENT_TIMESTAMP,
    [updated_at] DATETIME2 NOT NULL,
    CONSTRAINT [cw_connections_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[cw_uploads] (
    [id] UNIQUEIDENTIFIER NOT NULL,
    [dataset_id] UNIQUEIDENTIFIER,
    [table_id] UNIQUEIDENTIFIER,
    [original_filename] NVARCHAR(500) NOT NULL,
    [blob_name] NVARCHAR(700) NOT NULL,
    [size_bytes] BIGINT NOT NULL,
    [mode] VARCHAR(20) NOT NULL CONSTRAINT [cw_uploads_mode_df] DEFAULT 'replace',
    [key_column] VARCHAR(128),
    [status] VARCHAR(32) NOT NULL CONSTRAINT [cw_uploads_status_df] DEFAULT 'PENDING_UPLOAD',
    [progress] INT NOT NULL CONSTRAINT [cw_uploads_progress_df] DEFAULT 0,
    [preview_json] NVARCHAR(max),
    [mapping_json] NVARCHAR(max),
    [row_count] BIGINT,
    [inserted_count] BIGINT,
    [updated_count] BIGINT,
    [error_message] NVARCHAR(max),
    [created_at] DATETIME2 NOT NULL CONSTRAINT [cw_uploads_created_at_df] DEFAULT CURRENT_TIMESTAMP,
    [updated_at] DATETIME2 NOT NULL,
    CONSTRAINT [cw_uploads_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [cw_uploads_blob_name_key] UNIQUE NONCLUSTERED ([blob_name])
);

-- CreateTable
CREATE TABLE [dbo].[cw_dataset_versions] (
    [id] UNIQUEIDENTIFIER NOT NULL,
    [table_id] UNIQUEIDENTIFIER NOT NULL,
    [upload_id] UNIQUEIDENTIFIER,
    [row_count] BIGINT NOT NULL,
    [schema_json] NVARCHAR(max) NOT NULL,
    [created_at] DATETIME2 NOT NULL CONSTRAINT [cw_dataset_versions_created_at_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [cw_dataset_versions_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[cw_saved_queries] (
    [id] UNIQUEIDENTIFIER NOT NULL,
    [user_id] UNIQUEIDENTIFIER NOT NULL,
    [name] NVARCHAR(200) NOT NULL,
    [description] NVARCHAR(1000),
    [sql_text] NVARCHAR(max) NOT NULL,
    [created_at] DATETIME2 NOT NULL CONSTRAINT [cw_saved_queries_created_at_df] DEFAULT CURRENT_TIMESTAMP,
    [updated_at] DATETIME2 NOT NULL,
    CONSTRAINT [cw_saved_queries_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [cw_saved_queries_user_id_name_key] UNIQUE NONCLUSTERED ([user_id],[name])
);

-- CreateTable
CREATE TABLE [dbo].[cw_audit_events] (
    [id] UNIQUEIDENTIFIER NOT NULL,
    [user_id] UNIQUEIDENTIFIER,
    [token_id] UNIQUEIDENTIFIER,
    [event_type] VARCHAR(80) NOT NULL,
    [resource_type] VARCHAR(80),
    [resource_id] NVARCHAR(255),
    [detail_json] NVARCHAR(max),
    [ip_address] VARCHAR(64),
    [success] BIT NOT NULL CONSTRAINT [cw_audit_events_success_df] DEFAULT 1,
    [created_at] DATETIME2 NOT NULL CONSTRAINT [cw_audit_events_created_at_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [cw_audit_events_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[cw_jobs] (
    [id] UNIQUEIDENTIFIER NOT NULL,
    [type] VARCHAR(50) NOT NULL,
    [status] VARCHAR(20) NOT NULL CONSTRAINT [cw_jobs_status_df] DEFAULT 'QUEUED',
    [upload_id] UNIQUEIDENTIFIER,
    [payload_json] NVARCHAR(max),
    [attempts] INT NOT NULL CONSTRAINT [cw_jobs_attempts_df] DEFAULT 0,
    [max_attempts] INT NOT NULL CONSTRAINT [cw_jobs_max_attempts_df] DEFAULT 3,
    [available_at] DATETIME2 NOT NULL CONSTRAINT [cw_jobs_available_at_df] DEFAULT CURRENT_TIMESTAMP,
    [locked_at] DATETIME2,
    [locked_by] VARCHAR(120),
    [heartbeat_at] DATETIME2,
    [last_error] NVARCHAR(max),
    [created_at] DATETIME2 NOT NULL CONSTRAINT [cw_jobs_created_at_df] DEFAULT CURRENT_TIMESTAMP,
    [updated_at] DATETIME2 NOT NULL,
    CONSTRAINT [cw_jobs_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [cw_datasets_project_id_active_idx] ON [dbo].[cw_datasets]([project_id], [active]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [cw_columns_table_id_ordinal_idx] ON [dbo].[cw_columns]([table_id], [ordinal]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [cw_access_grants_user_id_idx] ON [dbo].[cw_access_grants]([user_id]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [cw_access_grants_token_id_idx] ON [dbo].[cw_access_grants]([token_id]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [cw_access_grants_database_user_id_idx] ON [dbo].[cw_access_grants]([database_user_id]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [cw_uploads_status_created_at_idx] ON [dbo].[cw_uploads]([status], [created_at]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [cw_dataset_versions_table_id_created_at_idx] ON [dbo].[cw_dataset_versions]([table_id], [created_at]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [cw_audit_events_created_at_idx] ON [dbo].[cw_audit_events]([created_at]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [cw_audit_events_event_type_created_at_idx] ON [dbo].[cw_audit_events]([event_type], [created_at]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [cw_jobs_status_available_at_idx] ON [dbo].[cw_jobs]([status], [available_at]);

-- AddForeignKey
ALTER TABLE [dbo].[cw_datasets] ADD CONSTRAINT [cw_datasets_project_id_fkey] FOREIGN KEY ([project_id]) REFERENCES [dbo].[cw_projects]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[cw_tables] ADD CONSTRAINT [cw_tables_dataset_id_fkey] FOREIGN KEY ([dataset_id]) REFERENCES [dbo].[cw_datasets]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[cw_columns] ADD CONSTRAINT [cw_columns_table_id_fkey] FOREIGN KEY ([table_id]) REFERENCES [dbo].[cw_tables]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[cw_access_grants] ADD CONSTRAINT [cw_access_grants_user_id_fkey] FOREIGN KEY ([user_id]) REFERENCES [dbo].[cw_users]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[cw_access_grants] ADD CONSTRAINT [cw_access_grants_token_id_fkey] FOREIGN KEY ([token_id]) REFERENCES [dbo].[cw_tokens]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[cw_access_grants] ADD CONSTRAINT [cw_access_grants_database_user_id_fkey] FOREIGN KEY ([database_user_id]) REFERENCES [dbo].[cw_database_users]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[cw_access_grants] ADD CONSTRAINT [cw_access_grants_project_id_fkey] FOREIGN KEY ([project_id]) REFERENCES [dbo].[cw_projects]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[cw_access_grants] ADD CONSTRAINT [cw_access_grants_dataset_id_fkey] FOREIGN KEY ([dataset_id]) REFERENCES [dbo].[cw_datasets]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[cw_uploads] ADD CONSTRAINT [cw_uploads_dataset_id_fkey] FOREIGN KEY ([dataset_id]) REFERENCES [dbo].[cw_datasets]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[cw_uploads] ADD CONSTRAINT [cw_uploads_table_id_fkey] FOREIGN KEY ([table_id]) REFERENCES [dbo].[cw_tables]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[cw_dataset_versions] ADD CONSTRAINT [cw_dataset_versions_table_id_fkey] FOREIGN KEY ([table_id]) REFERENCES [dbo].[cw_tables]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[cw_saved_queries] ADD CONSTRAINT [cw_saved_queries_user_id_fkey] FOREIGN KEY ([user_id]) REFERENCES [dbo].[cw_users]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[cw_audit_events] ADD CONSTRAINT [cw_audit_events_user_id_fkey] FOREIGN KEY ([user_id]) REFERENCES [dbo].[cw_users]([id]) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[cw_jobs] ADD CONSTRAINT [cw_jobs_upload_id_fkey] FOREIGN KEY ([upload_id]) REFERENCES [dbo].[cw_uploads]([id]) ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
