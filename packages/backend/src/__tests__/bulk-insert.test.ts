import { expect } from 'vitest';
import { Model, type Ref } from '@parcae/model';

import { BackendAdapter } from '../adapters/model';
import { itPostgres, createPostgresTestDatabase } from './postgres-test';

class ImportedRecord extends Model {
  static type = 'importedRecord' as const;
  title = 'Untitled';
  enabled = false;
  tags: string[] = [];
  meta = { label: '' };
  settings = { language: 'en' };
  owner: Ref<ImportedRecord> | null = null;
  observedAt: Date | null = null;
}

ImportedRecord.__schema = {
  title      : 'string',
  enabled    : 'boolean',
  tags       : 'json',
  meta       : 'json',
  owner      : { kind: 'ref', target: ImportedRecord },
  observedAt : 'datetime',
};

itPostgres(
  'bulk insert preserves model data and rejects a conflicting batch without overwriting rows',
  async () => {
    const database = await createPostgresTestDatabase();
    const adapter = new BackendAdapter({ read: database.db, write: database.db });
    const Record = ImportedRecord.bind(adapter);
    try {
      await adapter.ensureAllTables([Record]);
      const owner = Record.create();
      const observedAt = new Date('2025-01-02T03:04:05Z');
      const child = Record.create({
        owner,
        observedAt,
        tags     : ['one', 'two'],
        meta     : { label: 'imported' },
        settings : { language: 'fr' },
      });
      await adapter.insertMany([owner, child]);

      const rows = await Record.whereIn('id', [owner.id, child.id]).find();
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.id === owner.id)).toMatchObject({
        title    : 'Untitled',
        enabled  : false,
        tags     : [],
        settings : { language: 'en' },
      });
      expect(rows.find((row) => row.id === child.id)).toMatchObject({
        observedAt,
        $owner   : owner.id,
        tags     : ['one', 'two'],
        meta     : { label: 'imported' },
        settings : { language: 'fr' },
      });

      await database
        .db('importedRecords')
        .where({ id: child.id })
        .update({ meta: { label: 'concurrent' } });
      child.title = 'Renamed';
      await child.save();
      const saved = await Record.findById(child.id);
      expect(saved).toMatchObject({ title: 'Renamed', meta: { label: 'concurrent' } });

      const next = Record.create({ title: 'Next' });
      const conflict = Record.create({ id: child.id, title: 'Overwritten' });
      await expect(adapter.insertMany([next, conflict])).rejects.toMatchObject({ code: '23505' });
      expect(await Record.findById(next.id)).toBeNull();
      expect((await Record.findById(child.id))?.__data).toEqual(saved?.__data);

      await adapter.insertMany([next]);
      expect(await Record.findById(next.id)).toMatchObject({ title: 'Next' });
    } finally {
      await database.close();
    }
  },
);
