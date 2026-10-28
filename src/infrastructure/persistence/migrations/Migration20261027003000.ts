import { Migration } from "@mikro-orm/migrations";

export class Migration20261027003000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "wager_transactions"
        drop constraint "wager_transactions_kind_check",
        add constraint "wager_transactions_kind_check"
          check ("kind" in ('BET', 'WIN', 'REFUND', 'ROLLBACK', 'OPENING'));
    `);
    this.addSql('drop index "wager_transactions_single_reversal_idx";');
    this.addSql(`
      create unique index "wager_transactions_single_reversal_idx"
      on "wager_transactions" ("kind", "reference_id")
      where "kind" in ('REFUND', 'ROLLBACK')
        and "reference_id" is not null
        and "status" <> 'REJECTED';
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop index "wager_transactions_single_reversal_idx";');
    this.addSql(`
      create unique index "wager_transactions_single_reversal_idx"
      on "wager_transactions" ("reference_id")
      where "kind" in ('REFUND', 'ROLLBACK') and "reference_id" is not null;
    `);
    this.addSql(`
      alter table "wager_transactions"
        drop constraint "wager_transactions_kind_check",
        add constraint "wager_transactions_kind_check"
          check ("kind" in ('BET', 'WIN', 'REFUND', 'ROLLBACK', 'REVERSAL'));
    `);
  }
}
