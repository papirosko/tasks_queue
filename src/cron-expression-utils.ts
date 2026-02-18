import { option } from "scats";
import { CronExpressionParser } from "cron-parser";

/**
 * Helper methods for cron expression validation and next execution calculation.
 *
 * The default timezone is UTC to ensure deterministic behavior across
 * environments and to avoid implicit dependency on host-local timezone.
 */
export class CronExpressionUtils {
  static readonly DEFAULT_TIMEZONE = "UTC";

  /**
   * Validates a cron expression by trying to parse it and resolve the next execution date.
   *
   * This method supports both common cron variants:
   * - 5-field format: `minute hour day-of-month month day-of-week`
   * - 6-field format: `second minute hour day-of-month month day-of-week`
   *
   * The parser infers which format is provided by the number of fields.
   * If the expression is invalid, an error is thrown.
   *
   * @param expression cron expression to validate
   * @param timezone optional IANA timezone. Defaults to UTC for deterministic behavior.
   */
  static validate(
    expression: string,
    timezone: string = CronExpressionUtils.DEFAULT_TIMEZONE,
  ): void {
    this.nextExecutionDate(expression, new Date(), timezone);
  }

  /**
   * Computes the next execution date strictly after the provided base date.
   *
   * This method accepts both 5-field and 6-field cron expressions:
   * - 5-field expressions do not contain seconds and are interpreted with minute precision.
   * - 6-field expressions include seconds and are interpreted with second precision.
   *
   * The resulting date is calculated in the provided timezone.
   * If no timezone is passed, UTC is used to avoid environment-dependent behavior.
   *
   * @param expression cron expression in 5-field or 6-field format
   * @param baseDate baseline date from which the next tick should be found
   * @param timezone optional IANA timezone. Defaults to UTC.
   * @returns next execution timestamp
   */
  static nextExecutionDate(
    expression: string,
    baseDate: Date,
    timezone: string = CronExpressionUtils.DEFAULT_TIMEZONE,
  ): Date {
    const normalizedExpression = expression.trim();
    if (normalizedExpression.length === 0) {
      throw new Error("Cron expression must not be blank");
    }

    try {
      const parsed = CronExpressionParser.parse(normalizedExpression, {
        currentDate: baseDate,
        tz: option(timezone).filter((s) => s.trim().length > 0).orUndefined,
      });
      return parsed.next().toDate();
    } catch (e) {
      throw new Error(
        `Invalid cron expression '${normalizedExpression}': ${(e as Error).message}`,
      );
    }
  }
}
