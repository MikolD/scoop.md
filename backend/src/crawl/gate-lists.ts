// Hosts the devtool gate decides on without fetching anything (src/crawl/gate.ts).
// Plain data, meant to be extended. Each entry is a hostname pattern:
//   "bbc.co.uk"        that host and any subdomain of it
//   "google.*"         google.<any TLD> (google.com, google.co.uk, …) and subdomains
//   "*.myshopify.com"  subdomains only
// Hosts are compared without a leading "www.", as sites are (normalizeSite).
// An ALLOW entry may add a path prefix ("vercel.com/docs"); it then matches
// only start URLs under that path. ALLOW is checked first, so docs hosts under
// a denied domain (docs.aws.amazon.com, developers.google.com) still pass.

export type DenyCategory = 'search-engine' | 'ecommerce' | 'social' | 'news' | 'other';

export const DENY: Record<DenyCategory, string[]> = {
  'search-engine': [
    'google.*', 'bing.com', 'duckduckgo.com', 'yahoo.*', 'baidu.com', 'yandex.*', 'ask.com', 'ecosia.org',
    'startpage.com', 'search.brave.com', 'qwant.com', 'naver.com', 'seznam.cz', 'aol.com', 'perplexity.ai', 'kagi.com',
  ],
  ecommerce: [
    'amazon.*', 'ebay.*', 'etsy.com', 'aliexpress.*', 'alibaba.com', 'walmart.*', 'target.com', 'bestbuy.com', 'costco.com',
    'homedepot.com', 'lowes.com', 'ikea.com', 'wayfair.com', 'temu.com', 'shein.com', 'zalando.*', 'rakuten.*', 'flipkart.com',
    'mercadolibre.*', 'mercadolivre.com.br', 'jd.com', 'taobao.com', 'tmall.com', 'otto.de', 'allegro.pl', 'newegg.com',
    'macys.com', 'nordstrom.com', 'asos.com', 'zara.com', 'hm.com', 'nike.com', 'adidas.*', 'booking.com',
    'airbnb.*', 'expedia.*', 'tripadvisor.*', 'uber.com', 'doordash.com', 'instacart.com', '*.myshopify.com',
  ],
  social: [
    'facebook.com', 'fb.com', 'instagram.com', 'x.com', 'twitter.com', 't.co', 'tiktok.com', 'youtube.com', 'youtu.be',
    'reddit.com', 'linkedin.com', 'pinterest.*', 'snapchat.com', 'tumblr.com', 'threads.net', 'whatsapp.com', 'telegram.org',
    'discord.com', 'twitch.tv', 'quora.com', 'vk.com', 'weibo.com', 'bsky.app', 'mastodon.social', 'netflix.com', 'spotify.com',
  ],
  news: [
    'bbc.co.uk', 'bbc.com', 'cnn.com', 'nytimes.com', 'theguardian.com', 'washingtonpost.com', 'wsj.com', 'reuters.com',
    'apnews.com', 'bloomberg.com', 'ft.com', 'foxnews.com', 'nbcnews.com', 'cbsnews.com', 'abcnews.go.com', 'usatoday.com',
    'news.yahoo.com', 'aljazeera.com', 'dailymail.co.uk', 'independent.co.uk', 'telegraph.co.uk', 'npr.org', 'politico.com',
    'buzzfeed.com', 'huffpost.com', 'forbes.com', 'businessinsider.com', 'cnbc.com', 'time.com', 'economist.com', 'spiegel.de',
    'lemonde.fr', 'elpais.com', 'msn.com',
  ],
  // Banking, payments for consumers, webmail and other everyday non-devtool services.
  other: [
    'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'citi.com', 'capitalone.com', 'hsbc.*', 'barclays.*', 'santander.*',
    'paypal.com', 'venmo.com', 'revolut.com', 'wise.com', 'monzo.com', 'coinbase.com', 'binance.com', 'robinhood.com',
    'outlook.com', 'live.com', 'office.com', 'mail.yahoo.com', 'proton.me', 'wikipedia.org', 'imdb.com', 'weather.com',
    'craigslist.org', 'zillow.com', 'indeed.com', 'glassdoor.com',
  ],
};

// Known developer documentation: accepted without the signal check or the AI call.
export const ALLOW: string[] = [
  'docs.stripe.com', 'stripe.com/docs', 'react.dev', 'developer.mozilla.org', 'nodejs.org', 'docs.deno.com', 'bun.sh/docs',
  'bun.com/docs', 'docs.python.org', 'go.dev', 'pkg.go.dev', 'doc.rust-lang.org', 'docs.rs', 'typescriptlang.org/docs', 'nextjs.org/docs', 'vuejs.org', 'svelte.dev/docs', 'docs.astro.build', 'remix.run/docs',
  'angular.dev', 'docs.djangoproject.com', 'fastapi.tiangolo.com', 'flask.palletsprojects.com', 'guides.rubyonrails.org',
  'api.rubyonrails.org', 'laravel.com/docs', 'docs.spring.io', 'developers.cloudflare.com', 'vercel.com/docs', 'docs.netlify.com',
  'docs.aws.amazon.com', 'fly.io/docs', 'docs.railway.com', 'docs.railway.app', 'render.com/docs', 'postgresql.org/docs', 'supabase.com/docs', 'prisma.io/docs', 'orm.drizzle.team', 'planetscale.com/docs',
  'mongodb.com/docs', 'redis.io/docs', 'neon.com/docs', 'neon.tech/docs', 'docs.turso.tech',
  'clerk.com/docs', 'auth0.com/docs', 'twilio.com/docs', 'resend.com/docs', 'twilio.com/docs/sendgrid',
  'docs.anthropic.com', 'docs.claude.com', 'platform.openai.com/docs', 'ai-sdk.dev', 'python.langchain.com', 'js.langchain.com',
  'docs.langchain.com', 'huggingface.co/docs', 'git-scm.com/docs', 'docs.github.com', 'docs.docker.com', 'kubernetes.io/docs',
  'developer.hashicorp.com', 'vite.dev', 'vitejs.dev', 'webpack.js.org', 'eslint.org/docs', 'prettier.io/docs', 'jestjs.io',
  'vitest.dev', 'playwright.dev', 'pnpm.io', 'tailwindcss.com/docs', 'ui.shadcn.com', 'radix-ui.com',
  'developers.google.com', 'cloud.google.com/docs', 'docs.cloud.google.com', 'firebase.google.com/docs', 'learn.microsoft.com', 'docs.npmjs.com',
  'docs.gitlab.com', 'readthedocs.io', 'readthedocs.org',
];
