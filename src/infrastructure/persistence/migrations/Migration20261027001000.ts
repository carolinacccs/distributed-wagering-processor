import { Migration } from "@mikro-orm/migrations";

export class Migration20261027001000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "wager_transactions"
        add column "player_id" text,
        add column "round_id" text,
        add column "reference_external_transaction_id" text,
        add column "payload_hash" text not null default '',
        add column "response_balance" numeric(19, 2);
    `);
    this.addSql(`
      update "wager_transactions" as transaction
      set "player_id" = wallet."player_id"
      from "wallets" as wallet
      where transaction."wallet_id" = wallet."id";
    `);
    this.addSql(`
      alter table "wager_transactions"
        alter column "player_id" set not null;
    `);
    this.addSql(`
      alter table "wager_transactions"
        drop constraint "wager_transactions_kind_check",
        add constraint "wager_transactions_kind_check"
          check ("kind" in ('BET', 'WIN', 'REFUND', 'ROLLBACK', 'REVERSAL')),
        drop constraint "wager_transactions_status_check",
        add constraint "wager_transactions_status_check"
          check ("status" in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'));
    `);
    this.addSql(`
      create unique index "wager_transactions_single_reversal_idx"
      on "wager_transactions" ("reference_id")
      where "kind" in ('REFUND', 'ROLLBACK') and "reference_id" is not null;
    `);
    this.addSql(`
      create index "wager_transactions_pending_reference_idx"
      on "wager_transactions" ("created_at", "id")
      where "status" = 'PENDING_REFERENCE';
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop index if exists "wager_transactions_pending_reference_idx";');
    this.addSql('drop index if exists "wager_transactions_single_reversal_idx";');
    this.addSql(`
      update "wager_transactions"
      set "status" = 'PENDING'
      where "status" = 'PENDING_REFERENCE';
    `);
    this.addSql(`
      alter table "wager_transactions"
        drop constraint "wager_transactions_status_check",
        add constraint "wager_transactions_status_check"
          check ("status" in ('PENDING', 'PROCESSED', 'REJECTED', 'FAILED')),
        drop constraint "wager_transactions_kind_check",
        add constraint "wager_transactions_kind_check"
          check ("kind" in ('BET', 'WIN', 'REFUND', 'REVERSAL'));
    `);
    this.addSql(`
      alter table "wager_transactions"
        drop column "response_balance",
        drop column "payload_hash",
        drop column "reference_external_transaction_id",
        drop column "round_id",
        drop column "player_id";
    `);
  }
}
