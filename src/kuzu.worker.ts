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
  KuzuPersistRequest,
  KuzuResponse,
  KuzuErrorResponse,
  QueryResult,
  QueryResults
} from './kuzu-messages';

// Import KuzuDB
const raw = require('kuzu-wasm/sync'); // eslint-disable-line
const kuzu = raw.default || raw;

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
  let binary = '';
  const len = u8.length;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(u8[i]);
  }
  return btoa(binary);
}
/**
 * Converts a Base64 string to a Uint8Array.
 */
function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);

  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

/**
 * Serializes a directory in the Kuzu filesystem to a map of filenames to Base64 content.
 */
async function serializeDirectory(dir: string): Promise<Record<string, string>> {
  const FS = kuzu.getFS();

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
  const FS = kuzu.getFS();

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
    await kuzu.init();

    // Restore persisted data if provided
    if (request.dbData) {
      const files = JSON.parse(new TextDecoder().decode(new Uint8Array(request.dbData)));
      restoreDirectory('kuzu_data.db', files);
    }

    // Create database and connection
    db = new kuzu.Database('kuzu_data.db');
    conn = new kuzu.Connection(db);
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
 * Type-safe result extraction from a Kuzu QueryResult
 */

function extractQueryResult(result: any): QueryResult {

  // check if result was successful
  if (!result.isSuccess()) {
    console.error("Query failed:", result.getErrorMessage());
    throw new Error("Query failed: " + result.getErrorMessage());
  }

  const columnNames: string[] = result.getColumnNames();
  const columnTypes: string[] = result.getColumnTypes();
  const querySummary: Record<string, any> = result.getQuerySummary();
  const numRows: number = result.getNumTuples();

  console.log(`Request returned ${numRows} results in ${querySummary.executionTime}ms:\n${result.toString()}`)

  const rows: Record<string, any>[] = result.getAllRows().map((row: any) => {
    // convert kuzu value
    const record: Record<string, any> = {};
    for (let i = 0; i < columnNames.length; i++) {
      const key = columnNames[i];
      const value = row[i];
      const type = columnTypes[i];
      record[key] = convertKuzuValue(value, type);
    }
    return record;
  });

  return rows;
}

function convertKuzuValue(value: any, type: any): any {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'INT64':
      // Convert BigInt to string to avoid serialization issues
      return value.toString();
    case 'INT32':
    case 'DOUBLE':
      return Number(value);
    case 'STRING':
      return String(value);
    case 'BOOLEAN':
      return Boolean(value);
    case 'LIST':
      return value.map((item: any) => convertKuzuValue(item, typeof item));
    default:
      return value;
  }
}

/**
 * Replace handleQuery implementation with this logic:
 */
function handleQuery(request: KuzuQueryRequest): KuzuResponse {
  try {
    if (!isInitialized) {
      throw new Error("Database not initialized");
    }

    const result = conn.query(request.cypher);

    // Check if the result is a single query result or multiple
    let data: QueryResult | QueryResults;
    if (!result.hasNextQueryResult()) {
      data = extractQueryResult(result);
    } else {
      data = [];
      do {
        const partialResult = result.getNextQueryResult();
        if (partialResult) {
          data.push(extractQueryResult(partialResult));
        }
      } while (result.hasNextQueryResult());
      data = data.filter((result: QueryResult) => result.length > 0);
    }

    return {
      id: request.id,
      type: "query-success",
      data: data
    };
  } catch (error) {
    return {
      id: request.id,
      type: "error",
      error: error.message || "Unknown query error",
      requestType: "query"
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