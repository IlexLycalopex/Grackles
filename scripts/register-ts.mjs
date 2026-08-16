/** Registers the extensionless-TS resolver. See ts-resolve.mjs. */
import { register } from 'node:module';
register('./ts-resolve.mjs', import.meta.url);
