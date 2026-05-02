import dataSource from '../src/database/data-source';
import { LedgerEntryType } from '../src/database/db.enums';
import { SEED_ESCROW_ACCOUNT_ID } from '../src/database/seed-constants';
import { truncateTransactionalTables } from './helpers/e2e-test-helpers';

beforeAll(async () => {
  if (!dataSource.isInitialized) {
    await dataSource.initialize();
  }
  await dataSource.runMigrations({ transaction: 'each' });
});

afterAll(async () => {
  if (dataSource.isInitialized) {
    await dataSource.destroy();
  }
});

describe('Ledger immutability (e2e)', () => {
  beforeEach(async () => {
    await truncateTransactionalTables();
  });

  async function insertTestEntry(): Promise<{ id: string; amount: number }> {
    const rows = (await dataSource.query(
      `INSERT INTO "ledger_entries" ("id", "account_id", "type", "amount", "created_at")
       VALUES (gen_random_uuid(), $1, $2, $3, NOW())
       RETURNING "id", "amount"`,
      [SEED_ESCROW_ACCOUNT_ID, LedgerEntryType.Debit, 100],
    )) as { id: string; amount: number }[];
    return rows[0];
  }

  it('allows insert into ledger_entries', async () => {
    const inserted = await insertTestEntry();
    expect(inserted.id).toBeDefined();
    expect(Number(inserted.amount)).toBe(100);
  });

  it('rejects update on ledger_entries', async () => {
    const inserted = await insertTestEntry();

    await expect(
      dataSource.query(
        `UPDATE "ledger_entries"
         SET "amount" = $1
         WHERE "id" = $2`,
        [999, inserted.id],
      ),
    ).rejects.toThrow();
  });

  it('rejects delete on ledger_entries', async () => {
    const inserted = await insertTestEntry();

    await expect(
      dataSource.query(`DELETE FROM "ledger_entries" WHERE "id" = $1`, [inserted.id]),
    ).rejects.toThrow();
  });
});
