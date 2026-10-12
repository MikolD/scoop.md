// Types for package.js, so the backend (TypeScript) can import it directly:
// the admin console previews exactly what the extension copies.

export interface PackageSection {
  label: string;
  url: string;
  content: string | null;
  bytes?: number | null;
}

export const DEFAULT_BUDGET: number;

export function buildPackage(o: {
  site: string;
  pageUrl: string;
  sections: PackageSection[];
  relatedLinks?: { url: string; text?: string }[];
  budget?: number;
  now?: Date;
}): string;

export function withCurrentPage<T extends PackageSection>(sections: T[], currentPage: T | null, pageUrl?: string): T[];
