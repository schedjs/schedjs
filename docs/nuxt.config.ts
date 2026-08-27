export default defineNuxtConfig({
  extends: ['docus'],
  modules: ['./modules/sched-links'],

  // GitHub Pages project site: repo schedjs/schedjs → base path /schedjs/.
  // Asset/nav links must carry the base, else CSS + internal links 404
  // (schedjs.github.io/_nuxt/… vs /schedjs/_nuxt/…).
  app: {
    baseURL: '/schedjs/',
  },

  css: ['~/assets/css/main.css'],

  content: {
    build: {
      markdown: {
        highlight: {
          // vitesse вместо дефолтного material-theme — приглушённая, стильная
          // подсветка; theme: { default, dark } переключается по color mode.
          theme: { default: 'vitesse-light', dark: 'vitesse-dark' },
        },
      },
    },
  },

  // AI-ready docs: /llms.txt + /llms-full.txt + raw-markdown /raw/<path>.md
  llms: {
    domain: 'https://schedjs.github.io/schedjs',
    title: 'sched',
    description:
      'Cron done right — a queue-based, self-hosted cron scheduler for Node.js: reliable delivery, retries, run history, cancellation, web UI, CLI, MCP server, pluggable storage (SQLite/Postgres/MySQL/Mongo).',
  },

  // Docus ships a docs MCP server at /mcp (list-pages + read-page).
  // Enabled by default — no config needed unless you want to turn it off.
  // mcp: { enabled: true },

  compatibilityDate: '2026-08-16',

  // Docus defu-fills appConfig.github from the LOCAL git remote (our private
  // Gitea) into the inline config, which wins over app/app.config.ts. Set it
  // here (nuxt.config appConfig feeds the inline config before modules run)
  // with public values + env switch so no private host ships in the bundle.
  appConfig: {
    github: {
      owner: 'schedjs',
      name: 'sched',
      url: process.env.NUXT_PUBLIC_REPO_URL ?? 'https://github.com/schedjs/schedjs',
      branch: 'main',
    },
  },

  // Link variables — единственный источник правды для repo/registry URL в доках.
  // При публикации на npm + GitHub — переключить через env (без правки контента):
  //   NUXT_PUBLIC_REPO_URL=https://github.com/schedjs/schedjs
  //   NUXT_PUBLIC_REGISTRY_URL=https://registry.npmjs.org
  //   NUXT_PUBLIC_DOCKER_REGISTRY_URL=ghcr.io/schedjs
  runtimeConfig: {
    public: {
      // Env читается ЗДЕСЬ (основной процесс build/dev) и кладётся в
      // runtimeConfig — content-воркер (content:file:beforeParse) не видит
      // process.env, но получает runtimeConfig целиком. Приватные дефолты =
      // внутренняя сборка; публичный релиз переключается env-переменными.
      repoUrl: process.env.NUXT_PUBLIC_REPO_URL ?? 'https://github.com/schedjs/schedjs',
      registryUrl: process.env.NUXT_PUBLIC_REGISTRY_URL ?? 'https://registry.npmjs.org',
      dockerRegistryUrl: process.env.NUXT_PUBLIC_DOCKER_REGISTRY_URL ?? 'ghcr.io/schedjs',
      packageScope: process.env.NUXT_PUBLIC_PACKAGE_SCOPE ?? '@schedjs',
    },
  },

  routeRules: {
    // Root is a marketing landing in Docus by default; we have none yet.
    // Redirect straight into the docs (sidebar layout).
    '/': { redirect: '/docs/introduction' },
    '/docs': { redirect: '/docs/introduction' },
  },

  nitro: {
    prerender: {
      // The '/' redirect stops the crawler from discovering /docs/* —
      // seed the crawl from the first docs page instead.
      routes: ['/docs/introduction'],
    },
  },
})

