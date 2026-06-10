/**
 * Utility functions for handling timezone conversions and formatting.
 */

export interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * Extract date parts in a given timezone.
 */
export function getDateParts(date: Date, timeZone: string): DateParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  });
  
  const parts = formatter.formatToParts(date);
  const partMap = Object.fromEntries(parts.map((p) => [p.type, p.value]));

  let hour = parseInt(partMap.hour, 10);
  if (hour === 24) hour = 0; // Some JS engines output 24 instead of 0 for midnight

  return {
    year: parseInt(partMap.year, 10),
    month: parseInt(partMap.month, 10) - 1, // 0-indexed
    day: parseInt(partMap.day, 10),
    hour,
    minute: parseInt(partMap.minute, 10),
    second: parseInt(partMap.second, 10),
  };
}

/**
 * Calculates the timezone offset in milliseconds for a specific Date in the target timezone.
 * Returns positive if the target timezone is ahead of UTC (e.g. +7 hours for Asia/Jakarta).
 */
export function getTzOffsetMs(date: Date, timeZone: string): number {
  const getParts = (tz: string) => {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hour12: false,
    });
    
    const parts = formatter.formatToParts(date);
    const partMap = Object.fromEntries(parts.map((p) => [p.type, p.value]));

    let hour = parseInt(partMap.hour, 10);
    if (hour === 24) hour = 0;

    return Date.UTC(
      parseInt(partMap.year, 10),
      parseInt(partMap.month, 10) - 1,
      parseInt(partMap.day, 10),
      hour,
      parseInt(partMap.minute, 10),
      parseInt(partMap.second, 10)
    );
  };

  return getParts(timeZone) - getParts("UTC");
}

/**
 * Create a Date object representing the given local date/time in the target timezone.
 */
export function createDateInTimeZone(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
  timeZone: string
): Date {
  const temp = new Date(Date.UTC(year, month, day, hour, minute, second, millisecond));
  const offset = getTzOffsetMs(temp, timeZone);
  return new Date(temp.getTime() - offset);
}
