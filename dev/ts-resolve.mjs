// Lets plain Node run the TypeScript sources of dev tools (the demo) with its
// built-in type stripping: registers ts-resolve-hooks.mjs. Usage:
//   node --import ./dev/ts-resolve.mjs dev/demo.ts

import { register } from 'node:module';

register('./ts-resolve-hooks.mjs', import.meta.url);
