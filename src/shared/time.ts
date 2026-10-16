// Dates of commits as GitLens shows them, for the host (tree views) and the webview (line blame).

/** `3 days ago`. */
export function relativeTime(seconds: number, now = Date.now() / 1000): string {
  const s = Math.max(0, now - seconds);
  const steps: [number, string][] = [[31536000, 'year'], [2592000, 'month'], [604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
  for (const [size, unit] of steps) {
    const n = Math.floor(s / size);
    if (n >= 1) return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  }
  return 'just now';
}
