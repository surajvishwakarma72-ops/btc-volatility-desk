import { describe, expect, it } from 'vitest';
import { classifyHeadline } from './classify.js';

const sev = (t: string) => classifyHeadline(t)?.severity ?? null;

describe('classifyHeadline: CRITICAL (close open positions)', () => {
  it.each([
    'Binance hacked: attackers drain $400M from hot wallet',
    'Bybit suffers $1.4 billion exploit in largest crypto hack ever',
    'Crypto exchange hacked, users report missing funds',
    'Coinbase suspends withdrawals amid security incident',
    'OKX halts withdrawals after suspicious activity',
    'Withdrawals paused on Kraken as investigation continues',
    'USDC loses its dollar peg, trades at $0.88',
    'Tether depegs as redemptions surge',
    'Crypto exchange files for bankruptcy, withdrawals frozen',
    'China bans all crypto trading',
    'Russia declares war; missile strikes reported',
  ])('%s', (t) => {
    expect(sev(t)).toBe('CRITICAL');
  });

  it('names the exchange in the reason', () => {
    expect(classifyHeadline('Binance hacked: attackers drain $400M')?.reason).toBe('Exchange hack: Binance');
  });
});

describe('classifyHeadline: never CRITICAL', () => {
  it.each([
    ['Ten growth hacks every crypto startup should know', 'LOW'],
    ['Hacker sentenced to 5 years for 2016 Bitfinex hack', 'HIGH'],
    ['Binance denies hack rumours, says funds are SAFU', 'HIGH'],
    ['Coinbase resumes withdrawals after brief pause', 'LOW'],
    ['Bitcoin hackathon draws record developer turnout', 'LOW'],
    ['Crypto exchange reimburses users two years after hack', 'HIGH'],
  ])('%s', (t, expected) => {
    expect(sev(t)).toBe(expected);
  });
});

describe('classifyHeadline: other levels', () => {
  it('large protocol hack is HIGH', () => expect(sev('DeFi lending protocol exploited for $400M')).toBe('HIGH'));
  it('small protocol hack is MEDIUM (feed only)', () => expect(sev('DeFi lending protocol exploited for $5M')).toBe('MEDIUM'));
  it('liquidation cascade is HIGH', () => expect(sev('Over $1.2 billion liquidated as bitcoin slides')).toBe('HIGH'));
  it('flash crash headline is MEDIUM (the price check alerts)', () => expect(sev('Bitcoin flash crash wipes out leveraged longs')).toBe('MEDIUM'));
  it('emergency Fed move is HIGH', () => expect(sev('Fed announces emergency rate cut')).toBe('HIGH'));
  it('exchange outage is HIGH', () => expect(sev('Binance outage leaves traders unable to log in')).toBe('HIGH'));
  it('CPI headline is MEDIUM', () => expect(sev('US CPI comes in hotter than expected')).toBe('MEDIUM'));
  it('plain crypto news is LOW', () => expect(sev('Bitcoin holds near $95,000 as traders await data')).toBe('LOW'));
  it('irrelevant headline is null', () => expect(sev('Local bakery wins national bread award')).toBeNull());
  it('ad ban is not a crypto ban', () => expect(sev('Platform bans crypto ads in Europe')).not.toBe('CRITICAL'));
});

// Real headlines from the live feeds on 2 Nov 2026 that must not pop up.
describe('classifyHeadline: real follow-ups, speculation and hoaxes stay quiet', () => {
  it.each([
    'Bitcoin ETFs sink into October outflows with $643M exit after Binance hack',
    'Trump could launch nuclear strike on Iran within days, commentator claims',
    'US nuclear strike on Iran? Tucker Carlson raises alarm',
    'Netanyahu pushes Trump into launching nuclear strikes on Iran — Tucker Carlson',
    "Sick cyber hoax: Ukraine's air raid app hacked, issued fake 'Oreshnik is on its way' nuclear alert",
    'Ukrainians sent false nuclear warning in suspected Russian hack',
    'Bitcoin rebounds above $78k as bulls attempt recovery after October selloff',
    'Bitcoin rattled by biggest crypto heist in history! Why Warren Buffett and Charlie Munger hated cryptocurrency',
    'Forex Today 02/11: Bitcoin Below $80,000 After Crypto Heist',
    "Bitcoin claws back toward $79,000 as markets shake off crypto's biggest hack",
    "'NUKE MISSILE COMING': Russia 'Nuclear Attack' Alert Sends Ukrainians Into Panic, Then This Happened",
    'Why stealing billions from a crypto exchange can be harder to stop than a bank theft',
    "Ukraine & Russia warned of NUCLEAR strike after emergency apps 'hijacked'",
    "Tucker Carlson: Netanyahu 'cornered and desperate,' pushing Trump for Iran attack",
    'Today in History: Nyerere Declares War on Amin After Uganda Invades Tanzania',
    "'Trump planning Nuclear Strike on Iran's Pickaxe Mountain': Tucker Carlson makes shocking claim",
    'Recap: How Binance’s record $6.3B hack unfolded',
    'Inside the largest crypto hack on record: How attackers breached Binance for $6.3 billion',
    'The fightback against Russia: how Britain is war-gaming an invasion',
    'Netanyahu pressuring Trump for nuclear strike on Iran: Carlson',
    'Toronto home invasion suspect wounded during break-in was allowed to walk free from hospital: cops',
    "Reddit Stock Plunges 30% as Google's AI Search Hits Traffic and User Growth",
    'Intel Stock Suffers Worst Crash in 50 Years as Weak Forecast Overshadows AI Chip Demand',
    "The Biggest Crypto Hack in History Just Happened. Here's What the $6.3 Billion Breach Means",
    'US-China military showdown: DF-26B missile strike on US warship mock-up viral',
    'EU Crypto Theft: Over $106M Lost in Suspected Crypto Theft',
    "Russians told 'nuclear attack underway' after hackers hijack government app",
    '$6.3 Billion Heist Shakes Crypto World as AI Offense and Defense Emerge as New Market Variables',
    'A $6.3 Billion Hack Tested Bitcoin’s Bull Market. 3 Signs It Passed',
    'Yemen : Houthi Missile Strike on Lahj Health Center Death Toll Rises to 10',
    'Sudan army launches air strikes on rebel positions',
    "Midterms: A Democratic Congress Can't Ban Bitcoin, But It Can Reach Many Intermediaries",
  ])('%s', (t) => {
    const s = sev(t);
    expect(s === null || s === 'LOW' || s === 'MEDIUM').toBe(true);
  });

  it('a live war event still is CRITICAL', () => expect(sev('Russia launches missile strikes on Kyiv')).toBe('CRITICAL'));
  it('an invasion still is CRITICAL', () => expect(sev('China launches invasion of Taiwan')).toBe('CRITICAL'));
  it('a strike by a major power still is CRITICAL', () => expect(sev('Israel launches missile strikes on Tehran')).toBe('CRITICAL'));
  it('an exchange hack named as the cause of a fall is a HIGH follow-up', () => expect(sev('Bitcoin plunges after Binance hack')).toBe('HIGH'));
});
