import Decimal from "decimal.js";
import { CurrencyMismatchError } from "./errors";

const MoneyDecimal = Decimal.clone({ precision: 1000 });
const AMOUNT_PATTERN = /^\d+(?:\.\d{1,2})?$/;

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static from(amount: string, currency: string): Money {
    if (
      typeof amount !== "string" ||
      !AMOUNT_PATTERN.test(amount) ||
      typeof currency !== "string" ||
      currency.trim().length === 0
    ) {
      throw new TypeError("Money requires a non-negative decimal string and currency.");
    }

    return new Money(new MoneyDecimal(amount).toDecimalPlaces(2), currency);
  }

  static zero(currency: string): Money {
    return Money.from("0", currency);
  }

  get amount(): string {
    return this.value.toFixed(2);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.greaterThan(other.value);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    if (this.value.lessThan(other.value)) {
      throw new RangeError("Money cannot be negative.");
    }
    return new Money(this.value.minus(other.value), this.currency);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError();
    }
  }
}
