// The one check the popup makes on an llms.txt it found itself (the library
// unreachable): it starts with an H1 and has at least one link, absolute or
// site-relative (/docs/x.md, as twilio.com's llms.txt has them).
export function verifyLlms(content) {
  if (typeof content !== 'string') return false;
  const first = content.split('\n').find((l) => l.trim());
  return Boolean(first && /^#\s+\S/.test(first.trim()) && /\[[^\]]+\]\((?:https?:\/\/|\/)[^)\s]+\)/.test(content));
}
