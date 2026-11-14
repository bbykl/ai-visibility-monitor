import { DatabaseSync, backup } from 'node:sqlite';
import { resolve } from 'node:path';
import { config } from '../src/config.js';

// SQLite online backup includes WAL state; never instantiate Store on a live DB.
const path = resolve(config.dataDir, `backup-${new Date().toISOString().replace(/[:.]/g,'-')}.sqlite`);
const db = new DatabaseSync(resolve(config.dataDir,'monitor.sqlite'), { readOnly:true });
try { await backup(db,path); console.log(`数据库已备份：${path}`); }
finally { db.close(); }
