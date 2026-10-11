// Data shapes from docs/BACKEND.md §4.

export type SectionKind = 'page-md' | 'llms' | 'llms-full' | 'page-html';

export interface Section {
  kind: SectionKind;
  label: string;
  url: string;
  content: string | null;
  bytes: number | null;
}

export interface RelatedLink {
  url: string;
  text: string;
}

export interface Source {
  kind: SectionKind;
  label: string;
  url: string;
}

// A validated POST /v1/skills body.
export interface NewSkill {
  site: string;
  pageUrl: string;
  title: string;
  sections: Section[];
  relatedLinks: RelatedLink[];
}

// What the API returns. A summary swaps sections/relatedLinks for sources/sizeBytes.
export interface SkillMeta {
  id: string;
  site: string;
  pageUrl: string;
  title: string;
  worked: number;
  failed: number;
  createdAt: string;
  lastWorkedAt: string | null;
  status: 'verified';
}

export interface Skill extends SkillMeta {
  sections: Section[];
  relatedLinks: RelatedLink[];
}

export interface SkillSummary extends SkillMeta {
  sources: Source[];
  sizeBytes: number;
}
