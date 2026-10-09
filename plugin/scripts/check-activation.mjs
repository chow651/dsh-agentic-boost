/**
 * Clean-room bundle + Skills activation check for the v2 slice.
 *
 * From a fresh temp DSH_HOME: creates an isolated profile that links this
 * plugin by path, runs `--dump-config` to prove the bundle row mounts, then
 * verifies every `plugin/skills/<name>/SKILL.md` parses (frontmatter
 * name/description/version) — the same shape `skill-filesystem` discovers.
 *
 * Usage:
 *   node plugin/scripts/check-activation.mjs [--plugin-dir <dir>]
 * Exit: 0 when the bundle row + all skills verify; 1 otherwise.
 * Never touches real `~/.dsh` or existing profiles (DSH_HOME override only).
 */
import { mkdtemp, readFile, writeFile, mkdir, rm, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(process.argv.includes('--plugin-dir')
  ? process.argv[process.argv.indexOf('--plugin-dir') + 1]
  : join(HERE, '..'));

const EXPECTED_SKILLS = ['v2-verify-loop', 'v2-investigate', 'v2-answer', 'v2-recover'];

const SKILL_FS_PKG = '@deepseek-ai/dsh-skill-filesystem';
const DSH_PKG = '@deepseek-ai/dsh';

/**
 * Portable locator for the SHIPPED FileSystemSkillProvider entry.
 *
 * Why this shape: the DSH install root differs per machine and package
 * manager, so no fixed prefix (`/usr/local/lib`, `%AppData%/npm`, ...)
 * is used. The only stable anchors are (a) the `dsh` executable already
 * on PATH — on this host a symlink to
 * `<root>/lib/node_modules/@deepseek-ai/dsh/lib/bin.js` — and (b) the
 * standard Node layout next to `process.execPath`. The locator scans
 * PATH with `node:path.delimiter` (no shell, no `which`, no string-built
 * shell command), resolves symlinks via `realpath`, walks up to the
 * `@deepseek-ai/dsh` package root (verified by package.json `name`), and
 * probes the bundled nested `node_modules/<pkg>/lib/index.js` npm layout
 * observed on this host, verifying the nested package.json `name` before
 * importing. Anything else resolves to `null` with a clear failure
 * instead of importing a wrong file.
 *
 * Boundary: Windows is NOT RUN in this session — PATHEXT/`.cmd` shims
 * and non-npm (pnpm-store, bundled-binary) layouts are not probed and
 * cross-platform success is not claimed.
 */
async function readPackageName(dir) {
  try {
    const text = await readFile(join(dir, 'package.json'), 'utf8');
    return JSON.parse(text)?.name ?? null;
  } catch {
    return null;
  }
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function walkUpToPackage(startDir, packageName, maxDepth = 8) {
  let dir = startDir;
  for (let i = 0; i < maxDepth; i++) {
    if (await readPackageName(dir) === packageName) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

async function findDshPackageRoot() {
  // Anchor A: `dsh` on PATH (same binary the install/dump steps spawn).
  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, 'dsh');
    if (!await isFile(candidate)) continue;
    let real = candidate;
    try {
      real = await realpath(candidate);
    } catch {
      // Unresolvable symlink: keep the literal path as best effort.
    }
    const root = await walkUpToPackage(dirname(real), DSH_PKG);
    if (root) return root;
  }
  // Anchor B: standard npm layout next to the running node binary
  // (`<prefix>/bin/node` <-> `<prefix>/lib/node_modules/...`).
  const prefixRoot = join(
    dirname(process.execPath), '..', 'lib', 'node_modules',
    '@deepseek-ai', 'dsh',
  );
  if (await readPackageName(prefixRoot) === DSH_PKG) return prefixRoot;
  return null;
}

async function resolveSkillFilesystemEntry() {
  const dshRoot = await findDshPackageRoot();
  if (!dshRoot) return null;
  const pkgDir = join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-skill-filesystem');
  if (await readPackageName(pkgDir) !== SKILL_FS_PKG) return null;
  const entry = join(pkgDir, 'lib', 'index.js');
  if (!await isFile(entry)) return null;
  return pathToFileURL(entry).href;
}

function parseFrontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) return null;
  const out = {};
  for (const line of match[1].split('\n')) {
    const kv = /^([A-Za-z-]+):\s*(.+)$/.exec(line.trim());
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

async function main() {
  const failures = [];
  // 1. Skills shape check (local, no DSH needed).
  for (const name of EXPECTED_SKILLS) {
    try {
      const text = await readFile(join(PLUGIN_DIR, 'skills', name, 'SKILL.md'), 'utf8');
      const fm = parseFrontmatter(text);
      if (!fm || fm.name !== name || !fm.description || !fm.version || !('output-contract' in fm)) {
        failures.push(`skill ${name}: frontmatter incomplete (${JSON.stringify(fm)})`);
      } else {
        console.log(`skill OK: ${name} version=${fm.version}`);
      }
    } catch (error) {
      failures.push(`skill ${name}: unreadable (${error?.message ?? error})`);
    }
  }

  // 2. Isolated bundle install + mount check via --dump-config. The pnpm
  // store must live under the temp dir too: the sandbox home's default
  // store is read-only (ERR_SQLITE_ERROR/EROFS), so redirect XDG dirs.
  const home = await mkdtemp(join(tmpdir(), 'abv2-home-'));
  const scratch = await mkdtemp(join(tmpdir(), 'abv2-xdg-'));
  try {
    const profileDir = join(home, 'profiles', 'dsh-agentic-boost-v2');
    await mkdir(profileDir, { recursive: true });
    await writeFile(
      join(profileDir, 'package.json'),
      JSON.stringify({
        name: 'dsh-profile-dsh-agentic-boost-v2',
        private: true,
        dependencies: { 'dsh-agentic-boost-mvp': `link:${PLUGIN_DIR}` },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', 'dsh-agentic-boost-mvp'] } },
      }),
      'utf8',
    );
    // NOTE: the bundle row id stays `agentic-boost-mvp` (plugin name is
    // unchanged); the profile dir name differs for isolation only.
    // The user layer must be a top-level YAML array (loader contract), so an
    // empty layer is `[]`, not a comment line.
    await writeFile(join(profileDir, 'cordis.patch.yml'), '[]\n', 'utf8');
    const isoEnv = {
      ...process.env,
      DSH_HOME: home,
      XDG_DATA_HOME: join(scratch, 'xdg-data'),
      XDG_CACHE_HOME: join(scratch, 'xdg-cache'),
      XDG_STATE_HOME: join(scratch, 'xdg-state'),
      NPM_CONFIG_CACHE: join(scratch, 'npm-cache'),
      COREPACK_HOME: join(scratch, 'corepack'),
    };
    const install = spawnSync('dsh', ['plugin', '--profile', 'dsh-agentic-boost-v2', 'install'], {
      env: isoEnv,
      encoding: 'utf8',
      timeout: 120000,
    });
    if (install.status !== 0) {
      failures.push(`plugin install exit ${install.status}: ${(install.stderr ?? '').slice(0, 500)}`);
    } else {
      console.log('install OK: dsh plugin install exit 0 (isolated DSH_HOME)');
    }
    const dump = spawnSync('dsh', ['--profile', 'dsh-agentic-boost-v2', '--dump-config'], {
      env: isoEnv,
      encoding: 'utf8',
      timeout: 120000,
    });
    if (dump.status !== 0) {
      failures.push(`--dump-config exit ${dump.status}: ${(dump.stderr ?? '').slice(0, 500)}`);
    } else if (!String(dump.stdout ?? '').includes('agentic-boost-mvp')) {
      failures.push('--dump-config output lacks the agentic-boost-mvp row');
    } else {
      console.log('bundle OK: agentic-boost-mvp row present in --dump-config');
    }
    // 3. Real provider list/get: instantiate the SHIPPED
    // FileSystemSkillProvider (dsh-skill-filesystem) against plugin/skills
    // via customSkillDirs and verify list() discovers all four candidates
    // with source=custom rank=300, and get() loads each body with
    // modelInvocable=true. Node-backed reads apply (no ctx.fs), the same
    // path the host takes for non-fs roots.
    try {
      const entryUrl = await resolveSkillFilesystemEntry();
      if (!entryUrl) {
        failures.push(
          'provider list/get probe skipped: dsh install root not found via PATH `dsh` or node prefix layout (see locator boundary)',
        );
      } else {
        const { FileSystemSkillProvider } = await import(entryUrl);
        const ctl = { signal: new AbortController().signal, invalidate: () => {} };
        const provider = new FileSystemSkillProvider(
          { get: () => undefined, logger: { warn: () => {} } },
          ctl,
          {
            includeDefaultRoots: false,
            customSkillDirs: [join(PLUGIN_DIR, 'skills')],
            watch: false,
          },
        );
        const listed = await provider.list({});
        const candidates = Array.isArray(listed) ? listed : (listed?.candidates ?? []);
        const names = new Set(candidates.map((c) => c.name));
        for (const name of EXPECTED_SKILLS) {
          const cand = candidates.find((c) => c.name === name);
          if (!cand) {
            failures.push(`provider list: missing ${name}`);
            continue;
          }
          if (cand.source !== 'custom' || cand.rank !== 300) {
            failures.push(`provider list: ${name} has source=${cand.source} rank=${cand.rank}, want custom/300`);
            continue;
          }
          const def = await provider.get(cand, {});
          if (!def || typeof def.content !== 'string' || def.content.length === 0) {
            failures.push(`provider get: ${name} returned no body`);
            continue;
          }
          if (def.invocation?.modelInvocable !== true) {
            failures.push(`provider get: ${name} not model-invocable`);
            continue;
          }
          console.log(`provider OK: list+get ${name} (custom/300, body ${def.content.length} chars)`);
        }
        await provider.dispose().catch(() => {});
      }
    } catch (error) {
      failures.push(`provider list/get probe failed: ${error?.message ?? error}`);
    }
    for (const name of EXPECTED_SKILLS) {
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) failures.push(`skill ${name}: not kebab-case`);
    }
    console.log('note: runtime visibility inside a booted agent (skill tool catalog) is NOT proven by this script — see report limitation');
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    for (const f of failures) console.error(`FAIL: ${f}`);
    process.exit(1);
  }
  console.log('activation check PASS');
}

await main();
