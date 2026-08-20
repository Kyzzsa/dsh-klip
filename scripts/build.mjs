#!/usr/bin/env node
/**
 * Build dsh-klip with esbuild.
 *
 * Host half -> lib/index.js (node ESM, trivial)
 *
 * Usage:
 *   node scripts/build.mjs          # build the host half
 *   node scripts/build.mjs --check  # verify the emitted host bundle shape
 */
import { build } from 'esbuild'
import { readFile, mkdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'

async function buildHost() {
  await mkdir('lib', { recursive: true })
  await build({
    entryPoints: ['src/index.ts'],
    outfile: 'lib/index.js',
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    // DSH host plugins resolve their service/preset peers at runtime from the
    // composed profile's node_modules, never ship them inside the bundle.
    packages: 'external',
    logLevel: 'warning',
  })
}

async function check() {
  const code = await readFile('lib/index.js', 'utf8')
  if (!code.includes('dsh-klip')) {
    throw new Error('host bundle: missing plugin identity')
  }
  if (!/klip/.test(code)) {
    throw new Error('host bundle: missing /klip command')
  }
  console.log('check: lib/index.js bundle shape OK')
}

/** Emit lib/types/*.d.ts from tsc so the exports' "types" fields resolve. */
function buildTypes() {
  execFileSync('npx', ['tsc'], { stdio: 'inherit' })
}

const flag = process.argv[2]
if (flag === '--check') {
  await check()
} else {
  await buildHost()
  buildTypes()
  await check()
  console.log('build: wrote lib/index.js and lib/types/')
}
