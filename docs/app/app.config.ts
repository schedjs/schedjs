export default defineAppConfig({
  ui: {
    colors: {
      primary: 'sky',
      neutral: 'slate',
    },
    contentNavigation: {
      slots: {
        linkTrailing: 'inline-flex gap-1.5 items-center',
      },
    },
  },
  docus: {
    title: 'sched',
    description: 'Cron done right — queue-based, self-hosted cron scheduler for Node.js: reliable delivery, run history, retries, cancellation, web UI, CLI, MCP server.',
  },
  header: {
    title: 'SCHED',
    logo: {
      light: 'https://schedjs.github.io/schedjs/logo.png',
      dark: 'https://schedjs.github.io/schedjs/logo.png',
      alt: 'sched',
      favicon: '/favicon.ico',
      class: 'h-10 w-auto shrink-0',
    },
  },
  // github: moved to nuxt.config.ts appConfig — Docus defu-fills the inline
  // config from the local git remote, which overrides app/app.config.ts.
  // github social: Docus auto-fills from the repo's git remote (pub remote =
  // github.com/schedjs/schedjs → correct public link, single icon). An explicit
  // entry here previously duplicated it (2 GitHub icons in the footer).
  socials: {},
})
