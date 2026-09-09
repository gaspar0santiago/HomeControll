#!/usr/bin/env node
'use strict';

// Produces a single self-contained file per Edge Function, for deploying
// through the Supabase dashboard instead of the CLI.
//
//   node tools/bundle-functions.js
//
// The dashboard's editor has no way to express `../_shared/door.ts`: that
// path reaches outside the function's own folder, which is a CLI bundling
// convention. So the shared module is inlined and the import dropped.
//
// The bundles are committed so they can be read and copied straight from
// GitHub by someone with no clone, which is the whole point. They are
// generated, never edited: CI regenerates them and fails on any difference,
// so they cannot quietly drift away from the sources.

const fs = require('fs');
const path = require('path');

const FUNCTIONS_DIR = path.join(__dirname, '..', 'supabase', 'functions');
const SHARED = path.join(FUNCTIONS_DIR, '_shared', 'door.ts');

const HEADER = `// GENERATED FILE, DO NOT EDIT.
//
// Built by tools/bundle-functions.js from index.ts plus _shared/door.ts,
// inlined into one file so it can be pasted into the Supabase dashboard,
// which cannot express an import reaching outside the function's folder.
//
// Edit index.ts or _shared/door.ts and regenerate:
//
//   node tools/bundle-functions.js
//
// Deploying with the CLI uses index.ts and ignores this file entirely.
`;

function inlineShared() {
  return fs.readFileSync(SHARED, 'utf8')
    // Module-local once inlined, so nothing needs exporting.
    .replace(/^export /gm, '')
    .trim();
}

function bundle(name) {
  const entry = path.join(FUNCTIONS_DIR, name, 'index.ts');
  const source = fs.readFileSync(entry, 'utf8');

  // The import spans several lines in these files.
  const withoutImport = source.replace(
    /import\s*\{[^}]*\}\s*from\s*["']\.\.\/_shared\/door\.ts["'];?\n/,
    ''
  );

  if (withoutImport === source && source.includes('_shared')) {
    throw new Error(`${name}: found a _shared reference the bundler did not strip`);
  }

  const out = [
    HEADER,
    '// ── inlined from _shared/door.ts ──────────────────────────────',
    inlineShared(),
    '',
    `// ── ${name}/index.ts ──────────────────────────────────────────`,
    withoutImport.trim(),
    ''
  ].join('\n');

  const target = path.join(FUNCTIONS_DIR, name, 'bundled.ts');
  fs.writeFileSync(target, out);
  return { target, lines: out.split('\n').length };
}

const names = fs.readdirSync(FUNCTIONS_DIR)
  .filter((n) => !n.startsWith('_'))
  .filter((n) => fs.existsSync(path.join(FUNCTIONS_DIR, n, 'index.ts')))
  .sort();

for (const name of names) {
  const { target, lines } = bundle(name);
  console.log(`${path.relative(path.join(__dirname, '..'), target)}  (${lines} lines)`);
}
