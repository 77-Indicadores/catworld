-- Replace the UNIQUE constraint on target_table_id (which rejects multiple NULLs in SQL Server)
-- with a filtered unique index that only enforces uniqueness on non-NULL values.

-- Drop the auto-generated unique constraint (name may vary; find and drop it)
DECLARE @ConstraintName nvarchar(200);
SELECT @ConstraintName = kc.name
FROM sys.key_constraints kc
JOIN sys.index_columns ic ON ic.object_id = kc.parent_object_id AND ic.index_id = kc.unique_index_id
JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
WHERE kc.parent_object_id = OBJECT_ID('dbo.cw_derived_tables')
  AND kc.type = 'UQ'
  AND c.name = 'target_table_id';

IF @ConstraintName IS NOT NULL
  EXEC('ALTER TABLE dbo.cw_derived_tables DROP CONSTRAINT [' + @ConstraintName + ']');

-- Filtered unique index: only enforce uniqueness when target_table_id IS NOT NULL
CREATE UNIQUE INDEX UX_cw_derived_tables_target_table_id
  ON dbo.cw_derived_tables(target_table_id)
  WHERE target_table_id IS NOT NULL;
