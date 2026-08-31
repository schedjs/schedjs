import { defineNuxtModule } from '@nuxt/kit'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Build-time link variables for the docs.
 *
 * MDC components in content are unreliable in this Docus/@nuxt/content stack
 * (SSR drops everything after the first component), so instead of components
 * we substitute tokens in the raw markdown before parsing:
 *
 *   [[gitclone]]            → `git clone <repoUrl>` block
 *   [[install:core]]        → install block for @schedjs/core
 *   [[install:daemon:global]] → install block for @schedjs/daemon (global bin)
 *
 * The values come from `runtimeConfig.public` (nuxt.config.ts), which is
 * env-overridable — at public publish (npm + GitHub) set:
 *   NUXT_PUBLIC_REPO_URL=https://github.com/schedjs/schedjs
 *   NUXT_PUBLIC_REGISTRY_URL=https://registry.npmjs.org
 *   NUXT_PUBLIC_DOCKER_REGISTRY_URL=ghcr.io/schedjs
 * The install blocks then render the npmjs variant automatically.
 */
export default defineNuxtModule({
  meta: { name: 'sched-links' },
  setup(_options, nuxt) {
    const pub = nuxt.options.runtimeConfig.public as Record<string, string | undefined>
    // Env уже применён в nuxt.config.ts runtimeConfig (основной процесс build).
    // process.env в content-воркере пуст — НЕ читать его здесь.
    const repoUrl = pub.repoUrl ?? 'https://github.com/schedjs/schedjs'
    const registryUrl = pub.registryUrl ?? 'https://registry.npmjs.org'
    const dockerRegistry = pub.dockerRegistryUrl ?? 'ghcr.io/schedjs'
    const scope = pub.packageScope ?? '@schedjs'
    const isPrivate = !registryUrl.includes('npmjs.org')

    // Parse-cache invalidation by env (bug #1056): @nuxt/content keys its
    // `.data/content/contents.sqlite` cache by the RAW markdown checksum, i.e.
    // BEFORE our [[token]] substitution below. Switching NUXT_PUBLIC_* env
    // (private build ↔ public build) therefore served stale substituted links
    // from the cache — the manual `rm -rf docs/.data` was required. Fix: key
    // the cache lifecycle on an env-hash marker — when the effective env
    // changes, drop the cache before content is parsed.
    const envHash = createHash('md5')
      .update([repoUrl, registryUrl, dockerRegistry, scope].join('|'))
      .digest('hex')
      .slice(0, 12)
    const cacheDir = join(nuxt.options.rootDir, '.data', 'content')
    const marker = join(cacheDir, '.env-hash')
    try {
      const prev = existsSync(marker) ? readFileSync(marker, 'utf8') : null
      if (prev !== envHash) {
        rmSync(cacheDir, { recursive: true, force: true })
        mkdirSync(cacheDir, { recursive: true })
        writeFileSync(marker, envHash)
      }
    } catch {
      // never let cache hygiene break the build
    }

    const repoDir = repoUrl.split('/').pop()!.replace(/\.git$/, '')

    const fenced = (lang: string, body: string) => `\`\`\`${lang}\n${body}\n\`\`\``

    const managerCommands = (name: string, global: boolean): string[] => {
      const g = global
      return [
        `npm ${g ? 'install -g' : 'install'} ${name}`,
        `yarn ${g ? 'global add' : 'add'} ${name}`,
        `pnpm ${g ? 'add -g' : 'add'} ${name}`,
        `bun ${g ? 'add -g' : 'add'} ${name}`,
      ]
    }

    const installBlock = (pkg: string, global: boolean): string => {
      const name = `${scope}/${pkg}`
      const out: string[] = []
      if (isPrivate) {
        out.push(
          `> \`${name}\` lives in our private registry (\`${registryUrl}\`). Configure your`,
          `> package manager once — the access token comes with registry credentials.`,
          ``,
          `npm / pnpm / bun — \`.npmrc\` (project or \`~/.npmrc\`):`,
          ``,
          fenced('ini', [
            `registry=${registryUrl}`,
            `//${registryUrl.replace(/^https?:\/\//, '')}/:_authToken=\${NPM_TOKEN}`,
          ].join('\n')),
          ``,
          `yarn — \`.yarnrc.yml\`:` ,
          ``,
          fenced('yaml', [
            `npmRegistryServer: "${registryUrl}"`,
            `npmAlwaysAuth: true`,
            `npmAuthToken: "\${NPM_TOKEN:-}"`,
            `# fresh publishes are quarantined by default — allow ours`,
            `npmMinimalAgeGate: 0`,
          ].join('\n')),
          ``,
          `Install \`${name}\` — pick your package manager:`,
        )
      } else {
        out.push(`Install \`${name}\` — pick your package manager:`)
      }
      out.push('', fenced('bash', managerCommands(name, global).join('\n')))
      return out.join('\n')
    }

    nuxt.hook('content:file:beforeParse', (ctx: { file: { body: string } }) => {
      ctx.file.body = ctx.file.body
        .replaceAll('[[repoUrl]]', repoUrl)
        .replaceAll('[[registryUrl]]', registryUrl)
        .replaceAll('[[dockerRegistry]]', dockerRegistry)
        .replaceAll('[[scope]]', scope)
        .replaceAll('[[gitclone]]', fenced('bash', `git clone ${repoUrl}\ncd ${repoDir}`))
        .replace(/\[\[install:([a-z-]+)(?::(global))?\]\]/g, (_m, pkg: string, mode?: string) =>
          installBlock(pkg, mode === 'global'),
        )
    })
  },
})
