import { CronExpressionUtils } from "../src/cron-expression-utils.js";
import { CronExpression } from "../src/cron-expression.js";

describe("CronExpressionUtils", () => {
  // Expect validation to accept 6-field cron expressions with second precision.
  it("validates six-field cron expressions", () => {
    expect(() =>
      CronExpressionUtils.validate(CronExpression.EVERY_10_SECONDS),
    ).not.toThrow();
  });

  // Expect validation to accept classic 5-field cron expressions without seconds.
  it("validates five-field cron expressions", () => {
    expect(() =>
      CronExpressionUtils.validate(CronExpression.EVERY_MINUTE),
    ).not.toThrow();
  });

  // Expect invalid expressions to fail fast with a clear error.
  it("throws for invalid expressions", () => {
    expect(() => CronExpressionUtils.validate("invalid cron")).toThrow(
      "Invalid cron expression",
    );
  });
});
