/**
 * Without this empty export, this file cannot be compiled under '--isolatedModules' 
 * because it is considered a global script file. 
 */
export { }

const raw = require('kuzu-wasm/sync'); // eslint-disable-line
const kuzuSync = raw.default || raw;
console.log("Kuzu module keys", Object.keys(kuzuSync));  // Debugging line

// Inside the worker script (kuzu.worker.ts)
let db: any;
let conn: any;
const ctx: DedicatedWorkerGlobalScope = self as any;

// Handle messages from main thread
self.onmessage = async (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'init':
      try {
        await kuzuSync.init();  // load WASM module
        // If persisted data was sent, write it to Kuzu's FS before opening DB
        if (msg.dbData) {
          const FS = kuzuSync.getFS();
          FS.writeFile('obsidian.db', new Uint8Array(msg.dbData));
        }
        // Open (or create) the database
        db = new kuzuSync.Database('obsidian');
        conn = new kuzuSync.Connection(db);
        ctx.postMessage({ type: 'init-done' });
      } catch (e) {
        ctx.postMessage({ type: 'error', error: e.message });
      }
      break;

    case 'query':
      try {
        const result: any = conn.query(msg.cypher);
        const resultStr = result.toString();  // get results as a string (JSON format)
        ctx.postMessage({ type: 'query-result', result: resultStr });
      } catch (e) {
        ctx.postMessage({ type: 'error', error: e.message });
      }
      break;

    case 'insert':
      try {
        conn.query(msg.cypher);
        ctx.postMessage({ type: 'insert-result', result: 'OK' });
      } catch (e) {
        ctx.postMessage({ type: 'error', error: e.message });
      }
      break;

    case 'persist':
      try {
        // Read the database file bytes from Kuzu’s FS
        const FS = kuzuSync.getFS();
        const data = FS.readFile('obsidian.db');
        ctx.postMessage({ type: 'persist-data', buffer: data.buffer }, [data.buffer]);
      } catch (e) {
        ctx.postMessage({ type: 'error', error: e.message });
      }
      break;
  }
};
