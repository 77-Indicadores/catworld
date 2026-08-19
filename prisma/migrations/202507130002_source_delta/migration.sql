ALTER TABLE dbo.cw_dataset_sources ADD delta_column VARCHAR(128) NULL;
ALTER TABLE dbo.cw_dataset_sources ADD last_delta_value NVARCHAR(MAX) NULL;
