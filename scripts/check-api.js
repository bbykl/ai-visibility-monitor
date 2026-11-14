import { verifyKey } from '../src/providers/deepseek.js';
import { safeError } from '../src/config.js';
try { console.log(JSON.stringify(await verifyKey())); }
catch (error) { console.error(safeError(error)); process.exitCode = 1; }
