/**
 * Lower-tail CDF of a Binomial(n, p): returns P(X <= k).
 * Iterates terms via the successive-ratio to stay numerically stable for large n.
 */
export function binomialCdfLowerTail(k: number, n: number, p: number): number {
  if (k < 0) return 0;
  if (k >= n) return 1;
  if (p <= 0) return 1;
  if (p >= 1) return 0;

  const q = 1 - p;
  // term(0) = q^n
  let term = Math.pow(q, n);
  let cdf = term;
  for (let i = 1; i <= k; i++) {
    // term(i) = term(i-1) * (n-i+1)/i * (p/q)
    term = term * ((n - i + 1) / i) * (p / q);
    cdf += term;
  }
  return Math.min(1, Math.max(0, cdf));
}
