/**
 * Headline classifier for the shock alert. Rules only, no model: a rule hit decides CRITICAL.
 *
 * CRITICAL = the kind of headline after which a short strangle should be closed, not held for a reversal:
 *   exchange hack / exploit / drained, withdrawals halted, stablecoin depeg, exchange insolvency, a country banning
 *   crypto, war or attack.
 * HIGH = big but not account-ending: protocol hacks, SEC action against a major name, ETF decisions, emergency Fed moves,
 *   liquidation cascades, flash crashes.
 * MEDIUM = top-tier macro in the headline (CPI, FOMC, NFP, rate decision).
 * LOW = anything else about bitcoin, crypto or markets.
 * null = not relevant.
 *
 * Retrospective stories ("hacker sentenced for 2016 hack") and denials ("Binance denies hack") never reach CRITICAL.
 */

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export type Category =
  | 'exchange_hack' | 'withdrawal_halt' | 'depeg' | 'insolvency' | 'ban' | 'war'
  | 'protocol_hack' | 'regulation' | 'etf' | 'fed' | 'liquidations' | 'crash'
  | 'macro' | 'general';

export interface Classification {
  severity: Severity;
  category: Category;
  /** Short reason shown in the popup, e.g. "Exchange hack: Binance". */
  reason: string;
  /** Exchanges, stablecoins and assets named in the headline (lower case). */
  entities: string[];
}

export const EXCHANGES = [
  'binance', 'coinbase', 'deribit', 'okx', 'bybit', 'kraken', 'bitfinex', 'bitstamp', 'kucoin', 'gate.io', 'htx', 'huobi',
  'bitget', 'mexc', 'gemini', 'crypto.com', 'upbit', 'bithumb', 'delta exchange', 'wazirx', 'coindcx', 'robinhood', 'bitmex',
];
const STABLES = ['usdt', 'tether', 'usdc', 'circle', 'dai', 'usde', 'ethena', 'fdusd', 'pyusd', 'tusd'];
const ASSETS = ['bitcoin', 'btc', 'ether', 'ethereum', 'eth', 'solana', 'sol', 'xrp'];

const RELEVANT = /bitcoin|\bbtc\b|crypto|stablecoin|\bether(eum)?\b|\beth\b|blockchain|\bdefi\b|\betf\b|\bsec\b|\bfed\b|federal reserve|fomc|\bcpi\b|inflation|payrolls|\bnfp\b|interest rate|rate (cut|hike)|stocks?|nasdaq|s&p|wall street|treasur|tariff|war\b|missile|invasion|nuclear|attack/i;

// Words that make "hack" mean something else.
const NOT_A_HACK = /growth hack|life ?hacks?|hackathon|hacker house|hack(ing)? (the|your) |productivity hack|ethical hack/i;
// A story about an old event, a court case or a denial: important, but not "close now".
const RETRO = /sentenced|convicted|pleads? guilty|\bjailed\b|extradit|indicted|charged with|\btrial\b|lawsuit over|years? (after|ago|later)|anniversary|lessons from|how the .* (hack|collapse)|recover(s|ed)? (funds|stolen)|returns? stolen|refund|reimburs|compensat|\bdenies\b|\bdenied\b|rumou?rs? (of|about)|\bfake\b|\bfalse\b|\bhoax\b|no funds (were )?lost|funds are safu|funds (are )?safe|resumes? withdrawals|withdrawals? resumed|restor(es|ed) withdrawals/i;

const HACK = /\bhack(ed|s|er|ers)?\b|exploit(ed)?\b|drain(ed|s)?\b|breach(ed)?\b|stolen|theft|heist|compromised|attack(ed|er)? (on|drains)|private keys? (leak|compromis)/i;
const HALT = /(halt|halts|halted|suspend|suspends|suspended|pause|pauses|paused|freeze|freezes|froze|frozen|stop|stops|stopped|block|blocks|blocked|disable[sd]?)\s+(all\s+)?(crypto\s+|btc\s+|bitcoin\s+|user\s+|customer\s+)?(withdrawals?|deposits and withdrawals|trading)|(withdrawals?|trading)\s+(are\s+|have been\s+|were\s+)?(halted|suspended|paused|frozen|stopped|disabled)/i;
const OUTAGE = /\b(outage|went down|goes down|is down|offline|downtime)\b/i;
const DEPEG = /de-?peg(s|ged)?\b|(loses?|lost|breaks?|broke) (its |the )?(dollar |usd )?peg|below \$?0\.9\d/i;
const INSOLVENT = /insolven|bankrupt|chapter 11|files? for bankruptcy|collaps(e|es|ed)\b|liquidity crisis|cannot (meet|process) withdrawals|bank run/i;
const BAN = /\bban(s|ned)?\b.*\b(crypto|bitcoin|trading|exchanges?)|\b(crypto|bitcoin)\b.*\bban(s|ned)?\b|outlaws? (crypto|bitcoin)|criminali[sz]es? (crypto|bitcoin)/i;
const WAR = /declares? war|(?<!home )\binvasion of\b|launch(es|ed)? (an |a full-scale )?invasion|invades?\b|missile (strike|attack)s?|air ?strikes? on|nuclear (strike|attack|weapon)|military strike|terror(ist)? attack|martial law|act of war/i;
const SEC_ACTION = /\bsec\b.*\b(sues|charges|lawsuit|wells notice|enforcement)|\b(doj|department of justice|cftc)\b.*\b(charges|sues|seiz)/i;
const ETF = /\betf\b.*\b(approv|reject|den(y|ies|ied)|delay|outflows? (record|surge)|launch)/i;
const FED_SHOCK = /emergency (rate )?(cut|hike|meeting)|surprise (rate )?(cut|hike)|fed (chair )?(resigns|fired|ousted)|intermeeting/i;
const LIQ = /liquidat(ed|ions?).*\$?\d+(\.\d+)?\s*(billion|bn|b\b)|\$?\d+(\.\d+)?\s*(billion|bn)\s+(in\s+)?liquidat/i;
const CRASH = /flash crash|plunges?|plummets?|crash(es|ed)?\b|tumbles?|nosedives?|sell-?off/i;
// The headline refers back to an event as the cause of something else: a follow-up, not the first report.
const AFTERMATH = /\b(after|following|since|amid|post-|in (the )?wake of)\b.{0,50}\b(hack|hacked|exploit|heist|breach|collapse|depeg|sell-?off|crash)|shakes? off|rattled by|fallout|aftermath/i;
// Follow-ups that are commentary, recaps or recovery: never a popup.
const DIGEST = /rebound|recover(s|y|ing)?\b|claws? back|bounces?|shakes? off|\bwhy\b|\bwhat\b|explain|lessons|outflows?|inflows?|recap|week in|weekly|monthly|analysis|opinion|buffett|munger/i;
// Talk about a possible war, not a war.
const SPECULATIVE = /\b(could|may|might|would|threat(s|en|ens|ened)?|warn(s|ed|ing)?|claim(s|ed)?|alarm|fears?|risk of|consider(s|ed|ing)?|weigh(s|ing)?|plan(s|ned|ning)?|push(es|ed|ing)?|urg(es|ed|ing)?|calls? for|possible|potential|if|shocking|cornered|desperate|pressur(e|es|ed|ing))\b|\?/i;
// Explainers, history, opinion and recaps are reading material, never an alarm.
const EXPLAINER = /^(why|how|what|who|when|inside)\b|today in history|this day in history|explainer|opinion|analysis|podcast|column|editorial|paradox|everything you need|as it happened|\brecap\b/i;
// An alert, drill or scare about an attack is not an attack.
const WAR_NOT_EVENT = /\balert\b|warning|panic|\bdrill\b|exercise|this happened|scare|war-?gam|simulat|pressur|mock-?up|viral|video|footage|showdown|hijack|hacked|hackers?\b|\btold\b/i;
// A war headline moves BTC only when a major power is in it; regional strikes and casualty updates do not.
const WAR_MAJOR = /\b(us|u\.s\.?|united states|america(n)?|pentagon|white house|trump|china|chinese|beijing|russia(n)?|moscow|kremlin|putin|nato|iran(ian)?|tehran|israel(i)?|taiwan|north korea(n)?|pyongyang|nuclear|europe(an)?|britain|british|uk)\b/i;
const WAR_UPDATE = /death toll|toll rises|rises to \d|killed in|casualt|wounded|injured|funeral|mourn|aid convoy|humanitarian/i;
// A headline saying a ban can't, won't or is unlikely to happen is about politics, not a ban.
const BAN_DENIED = /\b(can'?t|cannot|won'?t|will not|no plans? to|unlikely|rules? out|against (a|any) ban|not (going to|planning to)|midterms?|election)\b|can’t|won’t/i;
const CRYPTO = /crypto|bitcoin|\bbtc\b|defi|protocol|bridge|token|wallet|exchange|blockchain|stablecoin|\bether|\bnft|\bdex\b|on-?chain|web3|\bdao\b|lending|smart contract/i;
const REBOUND = /rebound|recover|bounce|claws? back|rall(y|ies)|rises|climbs|jumps|surges/i;
// Only a theft this big has moved BTC (Bybit $1.4B, Binance $6.3B); smaller ones go to the feed.
const BIG_HACK_USD = 250e6;
// Commentary about a hack: reading material, not a report of a new one.
const HACK_COMMENTARY = /here'?s|signs?\b|means|tested|shakes|lessons|\bwhat\b|\bwhy\b|\bhow\b|world|market variable|explain|analysis|bull market/i;

/** "$400M", "$1.4 billion" -> USD; null when the headline names no amount. */
export function amountUsd(t: string): number | null {
  const m = t.match(/\$\s?(\d+(?:[.,]\d+)?)\s?(k|thousand|m|mn|million|b|bn|billion)\b/i);
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  const u = m[2].toLowerCase();
  return n * (u.startsWith('b') ? 1e9 : u.startsWith('m') ? 1e6 : 1e3);
}

const MACRO = /\bcpi\b|inflation (data|report|print)|fomc|rate decision|nonfarm|non-farm|payrolls|\bnfp\b|\bpce\b|powell|jobs report/i;

function found(text: string, list: string[]): string[] {
  return list.filter((w) => {
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i').test(text);
  });
}

function cap(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Classify one headline (plus optional summary, used only for entities). Returns null when not relevant. */
export function classifyHeadline(title: string, summary = ''): Classification | null {
  const t = String(title || '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const exchanges = found(t, EXCHANGES);
  const stables = found(t, STABLES);
  const assets = found(`${t} ${summary}`, ASSETS);
  const entities = [...new Set([...exchanges, ...stables, ...assets])];
  const relevant = RELEVANT.test(t) || exchanges.length > 0 || stables.length > 0 || assets.length > 0;
  if (!relevant) return null;

  if (EXPLAINER.test(t)) return { severity: 'LOW', category: 'general', reason: 'Explainer or opinion', entities };

  const retro = RETRO.test(t);
  const after = AFTERMATH.test(t);
  const digest = after && DIGEST.test(t);
  const hack = HACK.test(t) && !NOT_A_HACK.test(t) && (CRYPTO.test(t) || exchanges.length > 0 || stables.length > 0);
  const ex = exchanges[0] ? cap(exchanges[0]) : '';
  const isExchange = exchanges.length > 0 || /\bexchange\b/i.test(t);
  const out = (severity: Severity, category: Category, reason: string): Classification => ({ severity, category, reason, entities });
  const name = ex ? `: ${ex}` : '';

  // Exchange-level events. A follow-up ("ETFs sink after Binance hack") is not a new shock.
  if (hack && isExchange) {
    if (digest) return out('LOW', 'exchange_hack', `Follow-up on exchange hack${name}`);
    if (retro) return out('HIGH', 'exchange_hack', `Exchange hack (old story or denial)${name}`);
    if (after) return out('HIGH', 'exchange_hack', `Exchange hack (follow-up report)${name}`);
    return out('CRITICAL', 'exchange_hack', `Exchange hack${name}`);
  }
  if (HALT.test(t) && isExchange) {
    return retro ? out('LOW', 'withdrawal_halt', `Withdrawals back to normal${name}`)
      : out('CRITICAL', 'withdrawal_halt', `Withdrawals halted${name}`);
  }
  if (DEPEG.test(t) && (stables.length || /stablecoin/i.test(t))) {
    if (retro || digest) return out('HIGH', 'depeg', 'Stablecoin depeg (old story or follow-up)');
    return out('CRITICAL', 'depeg', `Stablecoin depeg${stables[0] ? `: ${stables[0].toUpperCase()}` : ''}`);
  }
  if (INSOLVENT.test(t) && (exchanges.length || stables.length || /\bexchange\b/i.test(t))) {
    if (retro || digest) return out('HIGH', 'insolvency', 'Insolvency (old story or court case)');
    return out('CRITICAL', 'insolvency', `Insolvency${name}`);
  }
  if (BAN.test(t) && !retro && !SPECULATIVE.test(t) && !BAN_DENIED.test(t) && !/\bban(s|ned)?\b.*\b(ads?|advertis|memecoin)/i.test(t)) {
    return out('CRITICAL', 'ban', 'Crypto ban');
  }
  if (WAR.test(t)) {
    if (retro || SPECULATIVE.test(t) || WAR_NOT_EVENT.test(t)) return out('LOW', 'war', 'War talk, not an event');
    if (WAR_UPDATE.test(t)) return out('LOW', 'war', 'Conflict update');
    if (!WAR_MAJOR.test(t)) return out('LOW', 'war', 'Regional conflict');
    return out('CRITICAL', 'war', 'War or attack headline');
  }

  // Big but not account-ending. Small hacks and follow-ups go to the feed only.
  if (hack) {
    if (retro || after || HACK_COMMENTARY.test(t)) return out('LOW', 'protocol_hack', 'Hack follow-up or commentary');
    const usd = amountUsd(t);
    return usd != null && usd >= BIG_HACK_USD ? out('HIGH', 'protocol_hack', 'Large crypto hack')
      : out('MEDIUM', 'protocol_hack', 'Crypto hack (small or amount unknown)');
  }
  if (OUTAGE.test(t) && exchanges.length) return out('HIGH', 'withdrawal_halt', `Exchange outage: ${ex}`);
  if (FED_SHOCK.test(t)) return out('HIGH', 'fed', 'Unscheduled Fed move');
  if (LIQ.test(t) && !REBOUND.test(t)) return out('HIGH', 'liquidations', 'Liquidation cascade');
  if (SEC_ACTION.test(t) && !retro) return out('HIGH', 'regulation', 'Regulator action');
  if (ETF.test(t) && !digest) return out('HIGH', 'etf', 'ETF decision or flows');
  // A crash headline goes to the feed only: the BTC move check is the real, faster signal for a falling market.
  if (CRASH.test(t) && /bitcoin|\bbtc\b|crypto market|stock market|wall street|nasdaq|s&p/i.test(t) && !retro && !after && !REBOUND.test(t)) return out('MEDIUM', 'crash', 'Market falling (headline)');

  if (MACRO.test(t)) return out('MEDIUM', 'macro', 'Top-tier macro');
  return out('LOW', 'general', 'News');
}
