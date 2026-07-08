ALTER TABLE [dbo].[cw_jobs] ADD [weight] TINYINT NOT NULL CONSTRAINT [cw_jobs_weight_df] DEFAULT 0;

-- Jobs já na fila sem peso definido: assumir pesado (conservador)
UPDATE [dbo].[cw_jobs] SET [weight] = 2
WHERE [status] IN ('QUEUED', 'RUNNING') AND [type] = 'IMPORT_UPLOAD';
