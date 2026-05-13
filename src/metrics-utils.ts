export const sanitizeMetricPart = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_:]/g, "_");

export const poolMetricName = (poolName: string, suffix: string): string =>
  `tasks_queue_pool_${sanitizeMetricPart(poolName)}_${suffix}`;

export const queueMetricName = (queueName: string, suffix: string): string =>
  `tasks_queue_queue_${sanitizeMetricPart(queueName)}_${suffix}`;
