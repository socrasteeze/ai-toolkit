// Fork-only test helper (see FORK_NOTES.md). Registers ./tsResolve.mjs as an ESM resolve
// hook for `npm test`, so the contract suites can import app modules that use
// Next/webpack-style extensionless relative specifiers. No npm dependency — bare Node.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./tsResolve.mjs', pathToFileURL(`${import.meta.dirname}/`));
