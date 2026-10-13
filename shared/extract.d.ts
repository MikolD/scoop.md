// Types for extract.js, so the backend (TypeScript, no DOM lib) can import it
// directly. Only the DOM surface the callers use is described.

export interface DomNode {
  textContent: string | null;
  getAttribute(name: string): string | null;
  querySelector(selector: string): DomNode | null;
  querySelectorAll(selector: string): Iterable<DomNode>;
}

export function pickMain(doc: DomNode): DomNode;
export function htmlToMarkdown(root: DomNode, baseUrl: string): string;
export function relatedLinks(doc: DomNode, pageUrl: string, limit?: number): { url: string; text: string }[];
