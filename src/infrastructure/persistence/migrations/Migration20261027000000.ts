import { Migration } from "@mikro-orm/migrations";

export class Migration20261027000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "wallets" (
        "id" text primary key,
        "player_id" text not null,
        "currency" text not null,
        "balance" numeric(19, 2) not null default 0,
        "version" integer not null default 0,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "wallets_player_id_currency_unique" unique ("player_id", "currency"),
        constraint "wallets_balance_non_negative" check ("balance" >= 0),
        constraint "wallets_version_non_negative" check ("version" >= 0)
      );
    `);

    this.addSql(`
      create table "wager_transactions" (
        "id" text primary key,
        "wallet_id" text not null references "wallets" ("id"),
        "provider_id" text not null,
        "external_transaction_id" text not null,
        "idempotency_key" text not null,
        "kind" text not null,
        "status" text not null,
        "amount" numeric(19, 2) not null,
        "currency" text not null,
        "reference_id" text null references "wager_transactions" ("id"),
        "failure_code" text null,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "wager_transactions_provider_external_unique"
          unique ("provider_id", "external_transaction_id"),
        constraint "wager_transactions_idempotency_key_unique" unique ("idempotency_key"),
        constraint "wager_transactions_kind_check"
          check ("kind" in ('BET', 'WIN', 'REFUND', 'REVERSAL')),
        constraint "wager_transactions_status_check"
          check ("status" in ('PENDING', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint "wager_transactions_amount_positive" check ("amount" > 0)
      );
    `);

    this.addSql(`
      create table "wallet_ledger_entries" (
        "id" text primary key,
        "wallet_id" text not null references "wallets" ("id"),
        "transaction_id" text not null references "wager_transactions" ("id"),
        "direction" text not null,
        "amount" numeric(19, 2) not null,
        "currency" text not null,
        "balance_before" numeric(19, 2) not null,
        "balance_after" numeric(19, 2) not null,
        "created_at" timestamptz not null default now(),
        constraint "wallet_ledger_wallet_transaction_unique"
          unique ("wallet_id", "transaction_id"),
        constraint "wallet_ledger_direction_check"
          check ("direction" in ('DEBIT', 'CREDIT')),
        constraint "wallet_ledger_amount_positive" check ("amount" > 0),
        constraint "wallet_ledger_balance_before_non_negative" check ("balance_before" >= 0),
        constraint "wallet_ledger_balance_after_non_negative" check ("balance_after" >= 0),
        constraint "wallet_ledger_balance_math_check"
          check (
            ("direction" = 'CREDIT' and "balance_after" = "balance_before" + "amount")
            or
            ("direction" = 'DEBIT' and "balance_after" = "balance_before" - "amount")
          )
      );
    `);

    this.addSql(`
      create function "reject_wallet_ledger_mutation"()
      returns trigger
      language plpgsql
      as $$
      begin
        raise exception 'wallet_ledger_entries is immutable';
      end;
      $$;
    `);
    this.addSql(`
      create trigger "wallet_ledger_entries_immutable"
      before update or delete on "wallet_ledger_entries"
      for each row execute function "reject_wallet_ledger_mutation"();
    `);

    this.addSql(`
      create table "inbox_messages" (
        "id" text primary key,
        "consumer_name" text not null,
        "message_id" text not null,
        "body" text not null,
        "received_at" timestamptz not null default now(),
        constraint "inbox_consumer_message_unique" unique ("consumer_name", "message_id")
      );
    `);

    this.addSql(`
      create table "outbox_messages" (
        "id" text primary key,
        "message_id" text not null,
        "event_type" text not null,
        "body" text not null,
        "created_at" timestamptz not null default now(),
        "published_at" timestamptz null,
        "attempts" integer not null default 0,
        constraint "outbox_attempts_non_negative" check ("attempts" >= 0)
      );
    `);
    this.addSql(`
      create index "outbox_messages_unpublished_idx"
      on "outbox_messages" ("created_at", "id")
      where "published_at" is null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop index if exists "outbox_messages_unpublished_idx";');
    this.addSql('drop table if exists "outbox_messages";');
    this.addSql('drop table if exists "inbox_messages";');
    this.addSql('drop trigger if exists "wallet_ledger_entries_immutable" on "wallet_ledger_entries";');
    this.addSql('drop table if exists "wallet_ledger_entries";');
    this.addSql('drop function if exists "reject_wallet_ledger_mutation"();');
    this.addSql('drop table if exists "wager_transactions";');
    this.addSql('drop table if exists "wallets";');
  }
}
