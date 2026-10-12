// Types for privacy.js, so the backend (TypeScript) can import it directly.

export const SECRETISH: RegExp;
export function secretish(segment: string): boolean;
export function redactPath(path: string): string;
export function scrubText(text: string): string;
