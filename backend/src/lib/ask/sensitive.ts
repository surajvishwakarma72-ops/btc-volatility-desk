/**
 * Detects text that must never be placed in the chat's knowledge index or shown to anyone without
 * need: server addresses, SSH logins and key paths, connection strings, hostnames and tokens.
 * Used by the index builder (it refuses to write a file containing any of these) and by a test.
 */
export const SENSITIVE: Array<[string, RegExp]> = [
  ['IPv4 address', /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/],
  ['SSH target', /\b(ubuntu|root|opc|ec2-user|admin|debian|azureuser|deploy)@[\w.<>-]+|\bssh\s+(-\w+\s+\S+\s+)*\S+@\S+/i],
  ['SSH key path', /~\/\.ssh|\.pem\b|oracle_key|id_(rsa|ed25519)/i],
  ['connection string', /\b(postgres(ql)?|mysql|mongodb|redis):\/\/\S+/i],
  ['duckdns host', /\.duckdns\.org/i],
  ['token-like value', /\b(ghp_|github_pat_|sk-|xox[abp]-|AKIA)[A-Za-z0-9_-]{8,}/],
  ['key=value secret', /\b(secret|password|api[_-]?key|token)\s*[:=]\s*['"]?[A-Za-z0-9/+_-]{12,}/i],
];

export function findSensitive(text: string): string[] {
  return SENSITIVE.filter(([, re]) => re.test(text)).map(([name]) => name);
}
