/**
 * Without this empty export, this file cannot be compiled under '--isolatedModules' 
 * because it is considered a global script file. 
 */
export { }

const raw = require('kuzu-wasm/sync'); // eslint-disable-line
const kuzuSync = raw.default || raw;

// Inside the worker script (kuzu.worker.ts)
let db: any;
let conn: any;
const ctx: DedicatedWorkerGlobalScope = self as any;


function toBase64(u8: Uint8Array): string {
  return btoa(String.fromCharCode(...u8));
}

function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

async function serializeDirectory(dir: string): Promise<Record<string, string>> {
  const FS = kuzuSync.getFS();
  const files = FS.readdir(dir).filter((f: string) => f !== '.' && f !== '..');
  const result: Record<string, string> = {};

  for (const filename of files) {
    const fullPath = `${dir}/${filename}`;
    const stat = FS.stat(fullPath);
    console.log(`Serializing ${fullPath}, size: ${stat.size}`);
    if (FS.isFile(stat.mode)) {
      const data = FS.readFile(fullPath); // Uint8Array
      result[filename] = toBase64(data);  // Store as base64 string
    }
  }

  return result;
}

function restoreDirectory(dir: string, files: Record<string, string>) {
  const FS = kuzuSync.getFS();

  try {
    FS.mkdir(dir);
  } catch (e) {
    if (!e.message.includes('File exists')) {
      throw e;
    }
  }

  for (const [filename, base64Data] of Object.entries(files)) {
    const fullPath = `/${dir}/${filename}`;
    const uint8 = fromBase64(base64Data);  // Decode from base64
    console.log(`Restoring ${fullPath}, base64 length: ${base64Data.length}, uint8 size: ${uint8.length}`);
    FS.writeFile(fullPath, uint8, { encoding: "binary" });
    console.log(`Wrote file ${fullPath}, size: ${FS.stat(fullPath).size} bytes`);
    console.log("Post-restore FS listing:", FS.readdir(`/${dir}`));
  }
}


// Handle messages from main thread
self.onmessage = async (event) => {
  const msg = event.data;
  switch (msg.type) {

    case 'init':
      try {
        await kuzuSync.init();

        // If persisted data was sent, restore the folder contents
        if (msg.dbData) {
          console.log("Kuzu worker - restoring data");
          const files = JSON.parse(new TextDecoder().decode(new Uint8Array(msg.dbData)));
          console.log("Kuzu worker - restoring data into directory", files);
          restoreDirectory('kuzu_data.db', files);
          const FS = kuzuSync.getFS();
          FS.readdir("/")
            .filter((name: string) => name !== "." && name !== "..")
            .forEach((name: string) => {
              const path = `/${name}`;
              const size = FS.stat(path).size;
              console.log(`Restored ${path}: ${size} bytes`);
            });
        }

        db = new kuzuSync.Database('kuzu_data.db');
        conn = new kuzuSync.Connection(db);
        ctx.postMessage({ type: 'init-done' });
      } catch (e) {
        ctx.postMessage({ type: 'error', error: e.message });
      }
      break;

    case 'query':
      console.log("Kuzu worker - query");
      try {
        const result: any = conn.query(msg.cypher);
        const resultStr = result.toString();  // get results as a string (JSON format)
        ctx.postMessage({ type: 'query-done', result: resultStr });
      } catch (e) {
        ctx.postMessage({ type: 'error', error: e.message });
      }
      break;

    case 'insert':
      console.log("Kuzu worker - insert");

      try {
        conn.query(msg.cypher);
        ctx.postMessage({ type: 'insert-done', result: 'OK' });
      } catch (e) {
        ctx.postMessage({ type: 'error', error: e.message });
      }
      break;

    case 'persist':
      try {
        const files = await serializeDirectory('kuzu_data.db');
        console.log(`Kuzu worker - serializing data as files ${JSON.stringify(files)}`);
        ctx.postMessage({ type: 'persist-done', files });
      } catch (e) {
        ctx.postMessage({ type: 'error', error: e.message });
      }
      break;
    case 'fs-list':
      console.log("Kuzu worker - fs-list");
      try {
        // Read the database file bytes from Kuzu’s FS
        const FS = kuzuSync.getFS();
        console.log("FS root contents:", FS.readdir('/'));
        for (const name of FS.readdir('/')) {
          if (name !== '.' && name !== '..') {
            const stat = FS.stat(`/${name}`);
            console.log(`${name} → dir? ${FS.isDir(stat.mode)}, file? ${FS.isFile(stat.mode)}`);
          }
        }
      } catch (e) {
        ctx.postMessage({ type: 'error', error: e.message });
      }
      break;
  }
};
