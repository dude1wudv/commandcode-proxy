import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const eslint = new ESLint({
  cwd: root,
  overrideConfigFile: fileURLToPath(new URL('./eslint.config.js', import.meta.url)),
});
const results = await eslint.lintFiles(['lib', 'server.mjs', 'scripts', 'frontend/src']);
const formatter = await eslint.loadFormatter('stylish');
const text = await formatter.format(results);
if (text) console.log(text);
if (results.some(result => result.errorCount || result.fatalErrorCount)) process.exitCode = 1;
