/**
 * Web Worker implementation for KuzuDB operations.
 * Handles message-based communication with the main thread.
 */

/**
 * Without this empty export, this file cannot be compiled under '--isolatedModules' 
 * because it is considered a global script file. 
 */
export { }

import type {
  KuzuRequest,
  KuzuInitRequest,
  KuzuQueryRequest,
  KuzuInsertRequest,
  KuzuPersistRequest,
  KuzuResponse,
  KuzuErrorResponse
} from './kuzu-messages';

// Import KuzuDB
const raw = require('kuzu-wasm/sync'); // eslint-disable-line
const kuzuSync = raw.default || raw;

// Worker context
const ctx: DedicatedWorkerGlobalScope = self as any;

// KuzuDB state
let db: any;
let conn: any;
let isInitialized = false;

/**
 * Converts a Uint8Array to a Base64 string.
 */
function toBase64(u8: Uint8Array): string {
  return btoa(String.fromCharCode(...u8));
}

/**
 * Converts a Base64 string to a Uint8Array.
 */
function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

/**
 * Serializes a directory in the Kuzu filesystem to a map of filenames to Base64 content.
 */
async function serializeDirectory(dir: string): Promise<Record<string, string>> {
  const FS = kuzuSync.getFS();

  try {
    const files = FS.readdir(dir).filter((f: string) => f !== '.' && f !== '..');
    const result: Record<string, string> = {};

    for (const filename of files) {
      const fullPath = `${dir}/${filename}`;
      const stat = FS.stat(fullPath);

      if (FS.isFile(stat.mode)) {
        const data = FS.readFile(fullPath); // Uint8Array
        result[filename] = toBase64(data);  // Store as base64 string
      }
    }

    return result;
  } catch (error) {
    console.error(`Error serializing directory ${dir}:`, error);
    throw new Error(`Failed to serialize directory: ${error.message}`);
  }
}

/**
 * Restores a directory in the Kuzu filesystem from a map of filenames to Base64 content.
 */
function restoreDirectory(dir: string, files: Record<string, string>) {
  const FS = kuzuSync.getFS();

  try {
    // Create the directory if it doesn't exist
    try {
      FS.mkdir(dir);
    } catch (e) {
      if (!e.message.includes('File exists')) {
        throw e;
      }
    }

    // Write each file
    for (const [filename, base64Data] of Object.entries(files)) {
      const fullPath = `/${dir}/${filename}`;
      const uint8 = fromBase64(base64Data);  // Decode from base64
      FS.writeFile(fullPath, uint8, { encoding: "binary" });
    }
  } catch (error) {
    console.error(`Error restoring directory ${dir}:`, error);
    throw new Error(`Failed to restore directory: ${error.message}`);
  }
}

/**
 * Handles initialization requests.
 */
async function handleInit(request: KuzuInitRequest): Promise<KuzuResponse> {
  try {
    // Initialize KuzuDB WASM module
    await kuzuSync.init();

    // Restore persisted data if provided
    if (request.dbData) {
      const files = JSON.parse(new TextDecoder().decode(new Uint8Array(request.dbData)));
      restoreDirectory('kuzu_data.db', files);
    }

    // Create database and connection
    db = new kuzuSync.Database('kuzu_data.db');
    conn = new kuzuSync.Connection(db);
    isInitialized = true;

    return { id: request.id, type: 'init-success' };
  } catch (error) {
    return {
      id: request.id,
      type: 'error',
      error: error.message || 'Unknown initialization error',
      requestType: 'init'
    };
  }
}

/**
 * Handles query requests.
 */
function handleQuery(request: KuzuQueryRequest): KuzuResponse {
  try {
    // Check if initialized
    if (!isInitialized) {
      throw new Error('Database not initialized');
    }

    // Execute query (synchronous in WASM build)
    const result = conn.query(request.cypher);

    // Get the structured results using the native getAllObjects method
    const structuredData = result.getAllObjects();

    return {
      id: request.id,
      type: 'query-success',
      data: JSON.stringify(structuredData)
    };
  } catch (error) {
    return {
      id: request.id,
      type: 'error',
      error: error.message || 'Unknown query error',
      requestType: 'query'
    };
  }
}

/**
 * Handles insert requests.
 */
function handleInsert(request: KuzuInsertRequest): KuzuResponse {
  try {
    // Check if initialized
    if (!isInitialized) {
      throw new Error('Database not initialized');
    }

    // Execute insert (synchronous in WASM build)
    conn.query(request.cypher);

    return { id: request.id, type: 'insert-success' };
  } catch (error) {
    return {
      id: request.id,
      type: 'error',
      error: error.message || 'Unknown insert error',
      requestType: 'insert'
    };
  }
}

/**
 * Handles persist requests.
 */
async function handlePersist(request: KuzuPersistRequest): Promise<KuzuResponse> {
  try {
    // Check if initialized
    if (!isInitialized) {
      throw new Error('Database not initialized');
    }

    // Serialize the database
    const files = await serializeDirectory('kuzu_data.db');

    return {
      id: request.id,
      type: 'persist-success',
      files
    };
  } catch (error) {
    return {
      id: request.id,
      type: 'error',
      error: error.message || 'Unknown persist error',
      requestType: 'persist'
    };
  }
}

/**
 * Main message handler that routes requests to the appropriate handler.
 */
async function handleMessage(request: KuzuRequest): Promise<KuzuResponse> {
  try {
    switch (request.type) {
      case 'init':
        return await handleInit(request as KuzuInitRequest);

      case 'query':
        return handleQuery(request as KuzuQueryRequest);

      case 'insert':
        return handleInsert(request as KuzuInsertRequest);

      case 'persist':
        return await handlePersist(request as KuzuPersistRequest);
    }
  } catch (error) {
    // Catch any unexpected errors
    return {
      id: request.id,
      type: 'error',
      error: error.message || 'Unknown error',
      requestType: request.type
    };
  }
}

// Set up the message handler
ctx.onmessage = async (event) => {
  const request = event.data as KuzuRequest;

  try {
    const response = await handleMessage(request);
    ctx.postMessage(response);
  } catch (error) {
    // Final safety net for any uncaught errors
    ctx.postMessage({
      id: request.id,
      type: 'error',
      error: error.message || 'Unhandled worker error',
      requestType: request.type
    } as KuzuErrorResponse);
  }
};

// Log that the worker has started
console.log('KuzuDB worker initialized');