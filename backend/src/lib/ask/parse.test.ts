import { describe, expect, it } from 'vitest';
import { parseDate, parsePeriod, parseQuestion, parseStrategy, parseTable, parseTime } from './parse.js';

// 2026-10-28 (Wednesday) 12:00 IST
const NOW = Date.parse('2026-10-28T06:30:00Z');
const IST = 19_800_000;
const DAY = 86_400_000;
const midnight = (key: string) => Date.parse(`${key}T00:00:00Z`) - IST;

describe('parseStrategy', () => {
  it('maps plain-English names to strategy ids', () => {
    expect(parseStrategy(' how is the ny short doing ').strategy).toBe('NY_SHORT');
    expect(parseStrategy(' asia strangle ').strategy).toBe('ASIA_SHORT');
    expect(parseStrategy(' the 10 am trade ').strategy).toBe('ASIA_SHORT');
    expect(parseStrategy(' new york iron condor ').strategy).toBe('NY_IC');
    expect(parseStrategy(' asia condor ').strategy).toBe('ASIA_IC');
    expect(parseStrategy(' evening straddle ').strategy).toBe('EVE_LONG');
    expect(parseStrategy(' pre-dawn straddle ').strategy).toBe('PRE_LONG');
    expect(parseStrategy(' calendar spread ').strategy).toBe('CAL_BACK');
    expect(parseStrategy(' london sweep ').strategy).toBe('FUT_SWEEP_LDN');
    expect(parseStrategy(' ny sweep ').strategy).toBe('FUT_SWEEP_NY');
    expect(parseStrategy(' FUT_SIGNAL ').strategy).toBe('FUT_SIGNAL');
    expect(parseStrategy(' nothing here ')).toEqual({});
  });

  it('recognises strategy families', () => {
    expect(parseStrategy(' all futures ').group?.ids).toEqual(['FUT_SWEEP_LDN', 'FUT_SWEEP_NY', 'FUT_SIGNAL']);
    expect(parseStrategy(' the straddles ').group?.ids).toEqual(['EVE_LONG', 'PRE_LONG']);
    expect(parseStrategy(' condors ').group?.label).toBe('iron condors');
  });
});

describe('parseTime and parseDate', () => {
  it('reads 24h and am/pm clock times', () => {
    expect(parseTime(' at 10:05 ')).toBe('10:05');
    expect(parseTime(' at 10.05 ')).toBe('10:05');
    expect(parseTime(' 10 am ')).toBe('10:00');
    expect(parseTime(' 10:30pm ')).toBe('22:30');
    expect(parseTime(' 12 am ')).toBe('00:00');
    expect(parseTime(' 12 pm ')).toBe('12:00');
    expect(parseTime(' 25:00 ')).toBeUndefined();
    expect(parseTime(' no time ')).toBeUndefined();
  });

  it('reads ISO dates and relative days', () => {
    expect(parseDate(' on 2026-10-20 ', NOW)).toBe('2026-10-20');
    expect(parseDate(' yesterday ', NOW)).toBe('2026-10-27');
    expect(parseDate(' today ', NOW)).toBe('2026-10-28');
    expect(parseDate(' nothing ', NOW)).toBeUndefined();
  });
});

describe('parsePeriod (IST)', () => {
  it('today, yesterday, this week (Monday start), last week, this and last month', () => {
    const today = midnight('2026-10-28');
    expect(parsePeriod(' today ', NOW)).toEqual({ from: today, to: today + DAY, label: 'today' });
    expect(parsePeriod(' yesterday ', NOW)).toEqual({ from: today - DAY, to: today, label: 'yesterday' });
    const week = parsePeriod(' this week ', NOW)!;
    expect(week.from).toBe(midnight('2026-10-26')); // Monday
    const last = parsePeriod(' last week ', NOW)!;
    expect(last.from).toBe(midnight('2026-10-19'));
    expect(last.to).toBe(midnight('2026-10-26'));
    expect(parsePeriod(' this month ', NOW)!.from).toBe(midnight('2026-10-01'));
    const lm = parsePeriod(' last month ', NOW)!;
    expect(lm.from).toBe(midnight('2026-09-01'));
    expect(lm.to).toBe(midnight('2026-10-01'));
  });

  it('last N days and weeks, all time, and the most recent named weekday', () => {
    const today = midnight('2026-10-28');
    expect(parsePeriod(' last 7 days ', NOW)).toMatchObject({ from: today - 6 * DAY, label: 'last 7 days' });
    expect(parsePeriod(' past 2 weeks ', NOW)).toMatchObject({ from: today - 14 * DAY });
    expect(parsePeriod(' all time ', NOW)).toMatchObject({ from: 0, label: 'all time' });
    // Wednesday 28th: "friday" means the previous Friday the 23rd
    expect(parsePeriod(' on friday ', NOW)).toMatchObject({ from: midnight('2026-10-23') });
    expect(parsePeriod(' nothing ', NOW)).toBeUndefined();
  });
});

describe('parseTable and the broader intents', () => {
  it('finds tables by their names and by what people call them', () => {
    expect(parseTable(' summarise bot runs ')).toBe('bot_runs');
    expect(parseTable(' the alert logs ')).toBe('alert_logs');
    expect(parseTable(' indicator_snapshots ')).toBe('indicator_snapshots');
    expect(parseTable(' option flow ')).toBe('option_flow_buckets');
    expect(parseTable(' my nightly reviews ')).toBe('nightly_reviews');
    expect(parseTable(' minute records ')).toBe('bot_minute_marks');
    expect(parseTable(' nothing here ')).toBeUndefined();
  });

  it('routes database and concept questions', () => {
    const q = (s: string) => parseQuestion(s, NOW);
    expect(q('what data do you have?').intent).toBe('data_overview');
    expect(q('list all tables').intent).toBe('data_overview');
    expect(q('how much data is stored in the database').intent).toBe('data_overview');
    expect(q('summarise bot runs').intent).toBe('table_summary');
    expect(q('summary of indicator snapshots last 7 days')).toMatchObject({ intent: 'table_summary', table: 'indicator_snapshots', period: { label: 'last 7 days' } });
    expect(q('how many rows in alert_logs').intent).toBe('table_summary');
    expect(q('describe the nightly reviews table')).toMatchObject({ intent: 'table_summary', table: 'nightly_reviews' });
    expect(q('what is risk adx?').intent).toBe('concept');
    expect(q('explain n2n').intent).toBe('concept');
    expect(q('difference between contango and backwardation').intent).toBe('concept');
    // existing, more specific intents still win
    expect(q('latest nightly review').intent).toBe('nights');
    expect(q('what is the ny short rule').intent).toBe('rules');
    expect(q('why was the asia trade stopped').intent).toBe('explain');
  });
});

describe('parseQuestion intents', () => {
  const i = (q: string) => parseQuestion(q, NOW).intent;

  it('routes the questions the desk owner is likely to ask', () => {
    expect(i('what can you do?')).toBe('help');
    expect(i('Running positions')).toBe('positions');
    expect(i('how is the NY short doing?')).toBe('positions');
    expect(i('any open trades right now')).toBe('positions');
    expect(i("Today's PnL")).toBe('pnl');
    expect(i('how much did I make this week')).toBe('pnl');
    expect(i('win rate of the asia strangle last 30 days')).toBe('pnl');
    expect(i('why was the asia trade stopped?')).toBe('explain');
    expect(i('why did the last trade lose')).toBe('explain');
    expect(i('why no trade today?')).toBe('why_no_trade');
    expect(i("why didn't it enter the ny short yesterday")).toBe('why_no_trade');
    expect(i('what was happening at 10:05')).toBe('at_time');
    expect(i('what did the bot see at 22:30 yesterday')).toBe('at_time');
    expect(i('which session is best?')).toBe('ranking');
    expect(i('best strategy this month')).toBe('ranking');
    expect(i('how much did it give back from peak')).toBe('exit_quality');
    expect(i('when should I exit the asia condor')).toBe('exit_quality');
    expect(i('market now')).toBe('market');
    expect(i('what is dvol and funding')).toBe('concept');
    expect(i('replay summary')).toBe('replay');
    expect(i('what is the ny short rule?')).toBe('rules');
    expect(i('how does the calendar spread work')).toBe('rules');
    expect(i('recent errors')).toBe('events');
    expect(i('my manual trades')).toBe('manual_trades');
    expect(i('latest nightly review')).toBe('nights');
    expect(i('recalibration status')).toBe('recalibration');
    expect(i('telemetry audit mismatches')).toBe('audit');
    expect(i('last alerts sent')).toBe('alerts');
    expect(i('blah blah')).toBe('unknown');
    expect(i('what will the price be tomorrow')).toBe('unknown');
    expect(i('should i buy now')).toBe('unknown');
    expect(i('futures positions')).toBe('positions');
    expect(i('what will the ny short do tomorrow')).toBe('unknown'); // a forecast, not a recorded fact
    expect(i('what is the ny short pnl tomorrow')).not.toBe('unknown');
  });

  it('carries the strategy, period, time and date through', () => {
    const p = parseQuestion('why was the NY short stopped yesterday', NOW);
    expect(p).toMatchObject({ intent: 'explain', strategy: 'NY_SHORT', dateKey: '2026-10-27', period: { label: 'yesterday' } });
    const at = parseQuestion('what was happening at 10:30 pm yesterday', NOW);
    expect(at).toMatchObject({ intent: 'at_time', time: '22:30', dateKey: '2026-10-27' });
    expect(parseQuestion('top 3 trades', NOW).limit).toBe(3);
  });

  it('a bare strategy name asks for its results, and the help intent wins over everything', () => {
    expect(i('futures')).toBe('pnl');
    expect(i('help me understand pnl')).toBe('help');
  });
});
