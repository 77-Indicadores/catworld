ALTER TABLE cw_dataset_sources ADD source_group_id UNIQUEIDENTIFIER NULL;
CREATE INDEX IX_cw_dataset_sources_group ON cw_dataset_sources (source_group_id);
