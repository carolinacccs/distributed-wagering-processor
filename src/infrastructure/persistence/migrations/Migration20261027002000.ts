import { Migration } from "@mikro-orm/migrations";

export class Migration20261027002000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "wager_transactions"
        add column "reference_attempts" integer not null default 0,
        add column "next_reference_attempt_at" timestamptz not null default now(),
        add constraint "wager_transactions_reference_attempts_non_negative"
          check ("reference_attempts" >= 0);
    `);
    this.addSql(`
      create index "wager_transactions_reference_retry_idx"
      on "wager_transactions" ("next_reference_attempt_at", "created_at", "id")
      where "status" = 'PENDING_REFERENCE';
    `);
    this.addSql(`
      alter table "outbox_messages"
        add column "next_attempt_at" timestamptz not null default now(),
        add column "lease_token" text null,
        add column "leased_until" timestamptz null,
        add column "last_error" text null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop index if exists "wager_transactions_reference_retry_idx";');
    this.addSql(`
      alter table "outbox_messages"
        drop column "last_error",
        drop column "leased_until",
        drop column "lease_token",
        drop column "next_attempt_at";
    `);
    this.addSql(`
      alter table "wager_transactions"
        drop constraint "wager_transactions_reference_attempts_non_negative",
        drop column "next_reference_attempt_at",
        drop column "reference_attempts";
    `);
  }
}
