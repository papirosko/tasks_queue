import { Option } from "scats";
import { CronExpressionUtils } from "./cron-expression-utils.js";
import { MissedRunStrategy, TaskPeriodType } from "./tasks-model.js";
import type {
  ScheduleCronTaskDetails,
  SchedulePeriodicTaskDetails,
} from "./tasks-model.js";

export interface PeriodicScheduleConfig {
  repeatType: TaskPeriodType;
  repeatInterval: Option<number>;
  cronExpression: Option<string>;
  startAfter: Date;
  initialStart: Date;
  missedRunsStrategy: MissedRunStrategy;
}

export class PeriodicScheduleUtils {
  /**
   * Resolves persisted repeat interval based on periodic type.
   *
   * For `cron` schedules interval is not used and `null` is returned.
   * For fixed schedules, `period` must be present.
   *
   * @param task task schedule request
   * @param periodType requested period type
   * @returns repeat interval in milliseconds or `null` for cron
   */
  static resolveRepeatInterval(
    task: SchedulePeriodicTaskDetails | ScheduleCronTaskDetails,
    periodType: TaskPeriodType,
  ): number | null {
    if (periodType === TaskPeriodType.cron) {
      return null;
    }
    const periodicTask = task as SchedulePeriodicTaskDetails;
    if (periodicTask.period === undefined || periodicTask.period === null) {
      throw new Error(
        `Periodic task with type='${periodType}' must define 'period' in milliseconds`,
      );
    }
    return periodicTask.period;
  }

  /**
   * Resolves persisted cron expression based on periodic type.
   *
   * For fixed schedules cron expression is not used and `null` is returned.
   * For `cron` schedules a non-blank `cronExpression` is required.
   *
   * Supported expression formats:
   * - 5 fields: minute, hour, day-of-month, month, day-of-week
   * - 6 fields: second, minute, hour, day-of-month, month, day-of-week
   *
   * @param task task schedule request
   * @param periodType requested period type
   * @returns normalized cron expression or `null` for fixed schedules
   */
  static resolveCronExpression(
    task: SchedulePeriodicTaskDetails | ScheduleCronTaskDetails,
    periodType: TaskPeriodType,
  ): string | null {
    if (periodType !== TaskPeriodType.cron) {
      return null;
    }
    const cronTask = task as ScheduleCronTaskDetails;
    const cronExpression = cronTask.cronExpression?.trim();
    if (!cronExpression) {
      throw new Error(
        "Periodic task with type='cron' must define non-empty 'cronExpression'",
      );
    }
    return cronExpression;
  }

  /**
   * Calculates the next task start time for periodic tasks.
   *
   * Supported schedule sources:
   * - fixed interval (`fixed_rate`, `fixed_delay`)
   * - cron expression (`cron`)
   *
   * @param task periodic scheduling configuration
   * @param now current timestamp used as a base for delay and skip-missed semantics
   * @returns next start time
   */
  static calculateNextStartAfter(
    task: PeriodicScheduleConfig,
    now: Date,
  ): Date {
    return task.repeatType === TaskPeriodType.cron
      ? this.calculateNextCronStartAfter(task, now)
      : this.calculateNextIntervalStartAfter(task, now);
  }

  /**
   * Calculates next start for cron-based periodic tasks.
   *
   * Supported cron formats:
   * - 5 fields: minute, hour, day-of-month, month, day-of-week
   * - 6 fields: second, minute, hour, day-of-month, month, day-of-week
   *
   * Cron expressions are evaluated in UTC in the current implementation.
   *
   * @param task cron scheduling config
   * @param now current timestamp
   * @returns next start time for cron schedule
   */
  private static calculateNextCronStartAfter(
    task: PeriodicScheduleConfig,
    now: Date,
  ): Date {
    const cronExpression = task.cronExpression.match({
      some: (value) => value,
      none: () => {
        throw new Error("Cron periodic task must define 'cron_expression'");
      },
    });
    const baseDate =
      task.missedRunsStrategy === MissedRunStrategy.catch_up
        ? task.startAfter
        : now;
    return CronExpressionUtils.nextExecutionDate(cronExpression, baseDate);
  }

  /**
   * Calculates next start for interval-based periodic tasks.
   *
   * @param task interval scheduling config
   * @param now current timestamp
   * @returns next start time for fixed-rate or fixed-delay schedule
   */
  private static calculateNextIntervalStartAfter(
    task: PeriodicScheduleConfig,
    now: Date,
  ): Date {
    const repeatInterval = task.repeatInterval.match({
      some: (value) => value,
      none: () => {
        throw new Error(
          `Periodic task with type='${task.repeatType}' must define 'repeat_interval'`,
        );
      },
    });
    switch (task.repeatType) {
      case TaskPeriodType.fixed_rate:
        return task.missedRunsStrategy === MissedRunStrategy.catch_up
          ? new Date(task.startAfter.getTime() + repeatInterval)
          : this.calculateFixedRateSkipMissedNextStartAfter(
              task.initialStart,
              now,
              repeatInterval,
            );
      case TaskPeriodType.fixed_delay:
        return new Date(now.getTime() + repeatInterval);
      default:
        throw new Error(`Unsupported periodic task type: ${task.repeatType}`);
    }
  }

  /**
   * Calculates fixed-rate next start for skip-missed behavior.
   *
   * @param initialStart initial schedule anchor
   * @param now current timestamp
   * @param repeatInterval schedule period in milliseconds
   * @returns nearest fixed-rate slot at or after `now`
   */
  private static calculateFixedRateSkipMissedNextStartAfter(
    initialStart: Date,
    now: Date,
    repeatInterval: number,
  ): Date {
    const elapsed = now.getTime() - initialStart.getTime();
    const periods = Math.ceil(elapsed / repeatInterval);
    return new Date(initialStart.getTime() + periods * repeatInterval);
  }
}
