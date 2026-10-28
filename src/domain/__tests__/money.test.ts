import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError } from "../errors";
import { Money } from "../money";

describe("Money", () => {
  test("stores amounts with a fixed scale of two", () => {
    expect(Money.from("12.3", "USD").amount).toBe("12.30");
    expect(Money.zero("USD").amount).toBe("0.00");
  });

  test.each(["", "-1", "+1", "1.001", "1e2", "NaN", "Infinity", " 1", "1 "])(
    "rejects invalid amount %s",
    (amount) => {
      expect(() => Money.from(amount, "USD")).toThrow();
    },
  );

  test("adds precisely and rejects arithmetic across currencies", () => {
    expect(Money.from("0.1", "USD").add(Money.from("0.2", "USD")).amount).toBe("0.30");
    expect(() => Money.from("1", "USD").add(Money.from("1", "EUR"))).toThrow(
      CurrencyMismatchError,
    );
  });

  test("does not expose a mutable amount", () => {
    const money = Money.from("3.45", "USD");
    expect(Object.isFrozen(money)).toBe(true);
    expect(money.amount).toBe("3.45");
  });
});
