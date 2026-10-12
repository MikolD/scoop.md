// A site's topic tree from the topics table's (path, count) rows, where each
// prefix of a page's topic path has its own row.

export interface TopicNode {
  name: string;
  path: string;
  count: number;
  children: TopicNode[];
}

export function topicTree(rows: { path: string; count: number }[]): TopicNode[] {
  const roots: TopicNode[] = [];
  const byPath = new Map<string, TopicNode>();
  // Parents sort before their children.
  for (const { path, count } of [...rows].sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path))) {
    const cut = path.lastIndexOf('/');
    const node: TopicNode = { name: path.slice(cut + 1), path, count, children: [] };
    byPath.set(path, node);
    (cut < 0 ? roots : (byPath.get(path.slice(0, cut))?.children ?? roots)).push(node);
  }
  const order = (nodes: TopicNode[]) => {
    nodes.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    nodes.forEach((n) => order(n.children));
  };
  order(roots);
  return roots;
}
