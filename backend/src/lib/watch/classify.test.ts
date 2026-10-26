import { describe, expect, it } from 'vitest';
import { DEFAULT_WATCH, isAlarm, levelFor, normaliseSettings, pointsLeft, statusOf, worst, type WatchLeg } from './classify.js';

const leg = (over: Partial<WatchLeg> = {}): WatchLeg => ({ source: 'delta', group: 'g', groupLabel: 'strangle', symbol: 'C-BTC-82000-261027', side: 'sold', entry: 100, mark: 100, stop: 200, lots: 100, ...over });

describe('points left before the stop', () => {
  it('a call sold at 100 with a stop at 200: 180 leaves 20, 195 leaves 5, 200 leaves 0', () => {
    expect(pointsLeft(leg({ mark: 180 }))).toBe(20);
    expect(pointsLeft(leg({ mark: 195 }))).toBe(5);
    expect(pointsLeft(leg({ mark: 200 }))).toBe(0);
    expect(pointsLeft(leg({ mark: 210 }))).toBe(-10);
  });
  it('a bought leg is watched the other way: it loses as the mark falls to its stop', () => {
    expect(pointsLeft(leg({ side: 'bought', entry: 100, stop: 50, mark: 70 }))).toBe(20);
  });
  it('has no answer without a price', () => {
    expect(pointsLeft(leg({ mark: null }))).toBeNull();
  });
});

describe('levels: warn at 20 points, hard exit at 5, breach at the stop', () => {
  it('uses the thresholds in the example: 100 sold with a stop of 200', () => {
    const lv = (mark: number) => statusOf(leg({ mark }), DEFAULT_WATCH).level;
    expect(lv(150)).toBe('safe');
    expect(lv(179.9)).toBe('safe');
    expect(lv(180)).toBe('warn'); // exactly 20 points left
    expect(lv(190)).toBe('warn');
    expect(lv(195)).toBe('hard'); // exactly 5 points left
    expect(lv(199)).toBe('hard');
    expect(lv(200)).toBe('breach');
    expect(lv(240)).toBe('breach');
  });
  it('stays on until the leg is clearly back, so it does not flicker at the line', () => {
    expect(levelFor(21, DEFAULT_WATCH, 'warn')).toBe('warn'); // just past 20: still on
    expect(levelFor(22, DEFAULT_WATCH, 'warn')).toBe('warn');
    expect(levelFor(22.1, DEFAULT_WATCH, 'warn')).toBe('safe');
    expect(levelFor(21, DEFAULT_WATCH, 'safe')).toBe('safe'); // but it does not start early
    expect(levelFor(6, DEFAULT_WATCH, 'hard')).toBe('warn'); // back from the hard zone, still inside the warning
  });
  it('keeps the last level when the price is missing for a moment, and is safe if it never had one', () => {
    expect(levelFor(null, DEFAULT_WATCH, 'warn')).toBe('warn');
    expect(levelFor(null, DEFAULT_WATCH, 'safe')).toBe('safe');
  });
  it('the worst of several legs wins, and only safe is not an alarm', () => {
    expect(worst(['safe', 'warn', 'safe'])).toBe('warn');
    expect(worst(['warn', 'hard', 'breach'])).toBe('breach');
    expect(worst([])).toBe('safe');
    expect(isAlarm('safe')).toBe(false);
    expect(isAlarm('warn')).toBe(true);
  });
});

describe('settings are kept in a safe range', () => {
  it('fills the defaults and never lets the hard exit come before the warning', () => {
    expect(normaliseSettings(null)).toEqual(DEFAULT_WATCH);
    expect(normaliseSettings({ warnPoints: 10, hardPoints: 30 })).toMatchObject({ warnPoints: 10, hardPoints: 10 });
    expect(normaliseSettings({ warnPoints: -5, hardPoints: -1, stopMultiple: 99 })).toEqual({ warnPoints: 1, hardPoints: 0, stopMultiple: 10 });
    expect(normaliseSettings({ stopMultiple: 1 }).stopMultiple).toBe(1.1);
  });
});
