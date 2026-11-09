// Resolve hook for ts-resolve.mjs. The sources import `./x.js`
// (moduleResolution Bundler), which Node does not map to `./x.ts`: only a
// relative specifier of a missing .js file next to an existing .ts file, imported
// from a .ts module, is rewritten.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, next) {
  if (
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    specifier.endsWith('.js') &&
    context.parentURL?.endsWith('.ts')
  ) {
    const asJs = new URL(specifier, context.parentURL);
    const asTs = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
    if (!existsSync(fileURLToPath(asJs)) && existsSync(fileURLToPath(asTs))) {
      return next(asTs.href, context);
    }
  }
  return next(specifier, context);
}

// The runtime's role prompts (ADR 0020): a Markdown file is a module whose default is its text.
export async function load(url, context, next) {
  if (url.startsWith('file:') && url.endsWith('.md')) {
    const text = readFileSync(fileURLToPath(url), 'utf8');
    return {
      format: 'module',
      source: `export default ${JSON.stringify(text)};`,
      shortCircuit: true,
    };
  }
  return next(url, context);
}
