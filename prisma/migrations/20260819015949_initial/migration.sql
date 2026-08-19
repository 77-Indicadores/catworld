-- CreateTable
CREATE TABLE "cw_users" (
    "id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "password_hash" VARCHAR(500) NOT NULL,
    "role" VARCHAR(32) NOT NULL DEFAULT 'VIEWER',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cw_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cw_projects" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "description" VARCHAR(1000),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cw_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cw_storage_servers" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "server" VARCHAR(255) NOT NULL,
    "port" INTEGER,
    "database_name" VARCHAR(128) NOT NULL,
    "encrypted_credentials" TEXT NOT NULL,
    "ssl_mode" VARCHAR(32) NOT NULL DEFAULT 'require',
    "encrypt" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_status" VARCHAR(32),
    "last_latency_ms" INTEGER,
    "last_checked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cw_storage_servers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cw_datasets" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "storage_server_id" UUID,
    "name" VARCHAR(255) NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "description" VARCHAR(1000),
    "schema_name" VARCHAR(128) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cw_datasets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cw_tables" (
    "id" UUID NOT NULL,
    "dataset_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "sql_name" VARCHAR(128) NOT NULL,
    "row_count" BIGINT NOT NULL DEFAULT 0,
    "size_bytes" BIGINT NOT NULL DEFAULT 0,
    "last_data_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cw_tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cw_columns" (
    "id" UUID NOT NULL,
    "table_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "original_name" VARCHAR(255) NOT NULL,
    "sql_name" VARCHAR(128) NOT NULL,
    "sql_type" VARCHAR(100) NOT NULL,
    "nullable" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "cw_columns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cw_tokens" (
    "id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "prefix" VARCHAR(24) NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "expires_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cw_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cw_database_users" (
    "id" UUID NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "encrypted_password" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cw_database_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cw_access_grants" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "token_id" UUID,
    "database_user_id" UUID,
    "scope_type" VARCHAR(20) NOT NULL,
    "project_id" UUID,
    "dataset_id" UUID,
    "permission" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cw_access_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cw_connections" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "provider" VARCHAR(32) NOT NULL DEFAULT 'postgres',
    "environment" VARCHAR(32) NOT NULL,
    "server" VARCHAR(255) NOT NULL,
    "port" INTEGER,
    "database_name" VARCHAR(128) NOT NULL,
    "ssl_mode" VARCHAR(32) NOT NULL DEFAULT 'require',
    "encrypt" BOOLEAN NOT NULL DEFAULT true,
    "username" VARCHAR(255) NOT NULL,
    "encrypted_credentials" TEXT NOT NULL,
    "metadata_json" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_status" VARCHAR(32),
    "last_latency_ms" INTEGER,
    "last_checked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cw_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cw_dataset_sources" (
    "id" UUID NOT NULL,
    "dataset_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "target_table_id" UUID,
    "name" VARCHAR(255) NOT NULL,
    "mode" VARCHAR(20) NOT NULL,
    "source_kind" VARCHAR(20) NOT NULL,
    "source_group_id" UUID,
    "source_schema" VARCHAR(128),
    "source_table" VARCHAR(128),
    "source_sql" TEXT,
    "refresh_cron" VARCHAR(100),
    "key_column" VARCHAR(128),
    "delta_column" VARCHAR(128),
    "last_delta_value" TEXT,
    "last_status" VARCHAR(32),
    "last_row_count" BIGINT,
    "last_error" TEXT,
    "last_refreshed_at" TIMESTAMP(3),
    "next_refresh_at" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cw_dataset_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cw_uploads" (
    "id" UUID NOT NULL,
    "dataset_id" UUID,
    "table_id" UUID,
    "original_filename" VARCHAR(500) NOT NULL,
    "blob_name" VARCHAR(700) NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "mode" VARCHAR(20) NOT NULL DEFAULT 'replace',
    "key_column" VARCHAR(128),
    "status" VARCHAR(32) NOT NULL DEFAULT 'PENDING_UPLOAD',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "preview_json" TEXT,
    "mapping_json" TEXT,
    "row_count" BIGINT,
    "inserted_count" BIGINT,
    "updated_count" BIGINT,
    "file_hash" VARCHAR(32),
    "delta_json" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cw_uploads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cw_dataset_versions" (
    "id" UUID NOT NULL,
    "table_id" UUID NOT NULL,
    "upload_id" UUID,
    "row_count" BIGINT NOT NULL,
    "schema_json" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cw_dataset_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cw_saved_queries" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" VARCHAR(1000),
    "sql_text" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cw_saved_queries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cw_audit_events" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "token_id" UUID,
    "event_type" VARCHAR(80) NOT NULL,
    "resource_type" VARCHAR(80),
    "resource_id" VARCHAR(255),
    "detail_json" TEXT,
    "ip_address" VARCHAR(64),
    "success" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cw_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cw_derived_tables" (
    "id" UUID NOT NULL,
    "dataset_id" UUID NOT NULL,
    "target_table_id" UUID,
    "name" VARCHAR(255) NOT NULL,
    "sql_name" VARCHAR(128) NOT NULL,
    "query_sql" TEXT NOT NULL,
    "refresh_cron" VARCHAR(100),
    "last_status" VARCHAR(32),
    "last_row_count" BIGINT,
    "last_error" TEXT,
    "last_refreshed_at" TIMESTAMP(3),
    "next_refresh_at" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cw_derived_tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cw_jobs" (
    "id" UUID NOT NULL,
    "type" VARCHAR(50) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'QUEUED',
    "upload_id" UUID,
    "payload_json" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMP(3),
    "locked_by" VARCHAR(120),
    "heartbeat_at" TIMESTAMP(3),
    "weight" SMALLINT NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cw_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cw_users_email_key" ON "cw_users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "cw_projects_slug_key" ON "cw_projects"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "cw_datasets_schema_name_key" ON "cw_datasets"("schema_name");

-- CreateIndex
CREATE INDEX "cw_datasets_project_id_active_idx" ON "cw_datasets"("project_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "cw_datasets_project_id_slug_key" ON "cw_datasets"("project_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "cw_tables_dataset_id_sql_name_key" ON "cw_tables"("dataset_id", "sql_name");

-- CreateIndex
CREATE INDEX "cw_columns_table_id_ordinal_idx" ON "cw_columns"("table_id", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "cw_columns_table_id_sql_name_key" ON "cw_columns"("table_id", "sql_name");

-- CreateIndex
CREATE UNIQUE INDEX "cw_tokens_prefix_key" ON "cw_tokens"("prefix");

-- CreateIndex
CREATE UNIQUE INDEX "cw_tokens_token_hash_key" ON "cw_tokens"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "cw_database_users_name_key" ON "cw_database_users"("name");

-- CreateIndex
CREATE INDEX "cw_access_grants_user_id_idx" ON "cw_access_grants"("user_id");

-- CreateIndex
CREATE INDEX "cw_access_grants_token_id_idx" ON "cw_access_grants"("token_id");

-- CreateIndex
CREATE INDEX "cw_access_grants_database_user_id_idx" ON "cw_access_grants"("database_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "cw_dataset_sources_target_table_id_key" ON "cw_dataset_sources"("target_table_id");

-- CreateIndex
CREATE INDEX "cw_dataset_sources_dataset_id_active_idx" ON "cw_dataset_sources"("dataset_id", "active");

-- CreateIndex
CREATE INDEX "cw_dataset_sources_connection_id_idx" ON "cw_dataset_sources"("connection_id");

-- CreateIndex
CREATE INDEX "cw_dataset_sources_source_group_id_idx" ON "cw_dataset_sources"("source_group_id");

-- CreateIndex
CREATE INDEX "cw_dataset_sources_mode_refresh_cron_next_refresh_at_idx" ON "cw_dataset_sources"("mode", "refresh_cron", "next_refresh_at");

-- CreateIndex
CREATE UNIQUE INDEX "cw_uploads_blob_name_key" ON "cw_uploads"("blob_name");

-- CreateIndex
CREATE INDEX "cw_uploads_status_created_at_idx" ON "cw_uploads"("status", "created_at");

-- CreateIndex
CREATE INDEX "cw_dataset_versions_table_id_created_at_idx" ON "cw_dataset_versions"("table_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "cw_saved_queries_user_id_name_key" ON "cw_saved_queries"("user_id", "name");

-- CreateIndex
CREATE INDEX "cw_audit_events_created_at_idx" ON "cw_audit_events"("created_at");

-- CreateIndex
CREATE INDEX "cw_audit_events_event_type_created_at_idx" ON "cw_audit_events"("event_type", "created_at");

-- CreateIndex
CREATE INDEX "cw_derived_tables_dataset_id_active_idx" ON "cw_derived_tables"("dataset_id", "active");

-- CreateIndex
CREATE INDEX "cw_derived_tables_next_refresh_at_idx" ON "cw_derived_tables"("next_refresh_at");

-- CreateIndex
CREATE INDEX "cw_jobs_status_available_at_idx" ON "cw_jobs"("status", "available_at");

-- AddForeignKey
ALTER TABLE "cw_datasets" ADD CONSTRAINT "cw_datasets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "cw_projects"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cw_datasets" ADD CONSTRAINT "cw_datasets_storage_server_id_fkey" FOREIGN KEY ("storage_server_id") REFERENCES "cw_storage_servers"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cw_tables" ADD CONSTRAINT "cw_tables_dataset_id_fkey" FOREIGN KEY ("dataset_id") REFERENCES "cw_datasets"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cw_columns" ADD CONSTRAINT "cw_columns_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "cw_tables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cw_access_grants" ADD CONSTRAINT "cw_access_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "cw_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cw_access_grants" ADD CONSTRAINT "cw_access_grants_token_id_fkey" FOREIGN KEY ("token_id") REFERENCES "cw_tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cw_access_grants" ADD CONSTRAINT "cw_access_grants_database_user_id_fkey" FOREIGN KEY ("database_user_id") REFERENCES "cw_database_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cw_access_grants" ADD CONSTRAINT "cw_access_grants_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "cw_projects"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cw_access_grants" ADD CONSTRAINT "cw_access_grants_dataset_id_fkey" FOREIGN KEY ("dataset_id") REFERENCES "cw_datasets"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cw_dataset_sources" ADD CONSTRAINT "cw_dataset_sources_dataset_id_fkey" FOREIGN KEY ("dataset_id") REFERENCES "cw_datasets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cw_dataset_sources" ADD CONSTRAINT "cw_dataset_sources_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "cw_connections"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cw_dataset_sources" ADD CONSTRAINT "cw_dataset_sources_target_table_id_fkey" FOREIGN KEY ("target_table_id") REFERENCES "cw_tables"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cw_uploads" ADD CONSTRAINT "cw_uploads_dataset_id_fkey" FOREIGN KEY ("dataset_id") REFERENCES "cw_datasets"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cw_uploads" ADD CONSTRAINT "cw_uploads_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "cw_tables"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cw_dataset_versions" ADD CONSTRAINT "cw_dataset_versions_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "cw_tables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cw_saved_queries" ADD CONSTRAINT "cw_saved_queries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "cw_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cw_audit_events" ADD CONSTRAINT "cw_audit_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "cw_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cw_derived_tables" ADD CONSTRAINT "cw_derived_tables_dataset_id_fkey" FOREIGN KEY ("dataset_id") REFERENCES "cw_datasets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cw_derived_tables" ADD CONSTRAINT "cw_derived_tables_target_table_id_fkey" FOREIGN KEY ("target_table_id") REFERENCES "cw_tables"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cw_jobs" ADD CONSTRAINT "cw_jobs_upload_id_fkey" FOREIGN KEY ("upload_id") REFERENCES "cw_uploads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
