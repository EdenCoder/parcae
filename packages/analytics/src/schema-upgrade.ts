import type { Knex } from "knex";

interface UniqueIndexRow {
  indexName: string;
  columns: string[];
}

interface UniqueIndexResult {
  rows: UniqueIndexRow[];
}

export async function assertStructuralColumns(
  db: Knex,
  table: string,
  columns: readonly string[],
): Promise<void> {
  const missing = (
    await Promise.all(columns.map(async (column) =>
      await db.schema.hasColumn(table, column) ? null : column,
    ))
  ).filter((column): column is string => Boolean(column));
  if (missing.length > 0) {
    throw new Error(
      `[parcae/analytics] ${table} is missing structural columns: ${missing.join(", ")}. Automatic repair cannot safely synthesize identity or conflict keys; run an explicit versioned migration.`,
    );
  }
}

export async function ensureAdditiveColumn(
  db: Knex,
  table: string,
  column: string,
  add: (builder: Knex.AlterTableBuilder) => void,
): Promise<void> {
  if (!(await db.schema.hasColumn(table, column))) {
    await db.schema.alterTable(table, add);
  }
}

export async function assertUniqueConflictTarget(
  db: Knex,
  table: string,
  columns: readonly string[],
): Promise<void> {
  const result = await db.raw<UniqueIndexResult>(
    `SELECT index_class.relname AS "indexName",
            array_agg(attribute.attname::text ORDER BY indexed_column.ordinality) AS columns
       FROM pg_catalog.pg_index AS index_definition
       JOIN pg_catalog.pg_class AS index_class
         ON index_class.oid = index_definition.indexrelid
       CROSS JOIN LATERAL unnest(index_definition.indkey::smallint[])
         WITH ORDINALITY AS indexed_column(attnum, ordinality)
       JOIN pg_catalog.pg_attribute AS attribute
         ON attribute.attrelid = index_definition.indrelid
        AND attribute.attnum = indexed_column.attnum
      WHERE index_definition.indrelid = to_regclass(?)
        AND index_definition.indisunique
        AND index_definition.indisvalid
        AND index_definition.indisready
        AND index_definition.indimmediate
        AND index_definition.indpred IS NULL
        AND index_definition.indexprs IS NULL
        AND indexed_column.ordinality <= index_definition.indnkeyatts
      GROUP BY index_class.relname`,
    [table],
  );
  const required = [...columns].sort();
  const hasTarget = result.rows.some((index) => {
    const actual = [...index.columns].sort();
    return actual.length === required.length &&
      actual.every((column, position) => column === required[position]);
  });
  if (!hasTarget) {
    throw new Error(
      `[parcae/analytics] ${table} lacks a valid unique index or constraint for conflict target (${columns.join(", ")}). ON CONFLICT writes are unsafe; resolve duplicate rows, then add the target in an explicit versioned migration.`,
    );
  }
}
