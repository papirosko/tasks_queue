import { Clock } from "../../../src/clock.js";

export class ManualClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current);
  }

  set(now: Date): void {
    this.current = new Date(now);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
