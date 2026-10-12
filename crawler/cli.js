// Run a crawl locally, without a sandbox:
//   node cli.js https://docsify.js.org/ --max-pages 5 --max-minutes 2 > result.json
import { crawl } from './crawl.js';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};
const start = args.find((a) => /^https?:\/\//.test(a));
if (!start) {
  console.error('usage: node cli.js <start-url> [--max-pages N] [--max-minutes M] [--root /docs]');
  process.exit(2);
}
const result = await crawl({
  site: new URL(start).hostname.replace(/^www\./, ''),
  startUrls: [start],
  budget: { maxPages: Number(flag('max-pages', 10)), maxMinutes: Number(flag('max-minutes', 2)) },
  docsRoot: flag('root', '/'),
});
console.error(`${result.pages.length} pages, ${result.errors} errors, stopped by ${result.stoppedBy}`);
console.log(JSON.stringify(result, null, 2));
