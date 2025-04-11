import type {
  KuzuRequest,
  KuzuSuccessResponse,
  KuzuErrorResponse,
  KuzuResponse,
  KuzuInitRequest,
  KuzuQueryRequest,
  KuzuPersistRequest,
  KuzuQuerySuccess,
  KuzuPersistSuccess
} from './kuzu-messages';

/**
 * Client for interacting with the KuzuDB worker.
 * Provides a clean Promise-based API for database operations.
 */
export class KuzuClient {
  private worker: Worker;
  private messageHandlers: Map<string, {
    resolve: (value: any) => void,
    reject: (reason: any) => void,
    timeout: NodeJS.Timeout
  }>;
  private readonly DEFAULT_TIMEOUT = 30000; // 30 seconds

  /**
   * Creates a new KuzuDB client.
   * 
   * @param KuzuWorker Function that creates a new Worker instance
   */
  constructor(KuzuWorker: new () => Worker) {
    this.worker = new KuzuWorker();
    this.messageHandlers = new Map();

    // Set up message handler
    this.worker.onmessage = (event) => {
      const response = event.data as KuzuResponse;
      const handler = this.messageHandlers.get(response.id);

      if (handler) {
        // Clear the timeout
        clearTimeout(handler.timeout);

        if (response.type === 'error') {
          const errorResp = response as KuzuErrorResponse;
          handler.reject(new Error(`${errorResp.requestType} failed: ${errorResp.error}`));
        } else {
          handler.resolve(response);
        }

        this.messageHandlers.delete(response.id);
      }
    };

    // Handle worker errors
    this.worker.onerror = (error) => {
      console.error('Worker error:', error);

      // Reject all pending promises
      for (const [id, handler] of this.messageHandlers.entries()) {
        clearTimeout(handler.timeout);
        handler.reject(new Error('Worker error: ' + error.message));
        this.messageHandlers.delete(id);
      }
    };
  }

  /**
   * Sends a message to the worker and returns a promise that resolves
   * when a response is received.
   * 
   * @param message The message to send
   * @param timeout Optional timeout in milliseconds
   * @returns Promise that resolves with the response or rejects with an error
   */
  private sendMessage<T extends KuzuRequest, R extends KuzuSuccessResponse>(
    message: Omit<T, 'id'>,
    timeout: number = this.DEFAULT_TIMEOUT
  ): Promise<R> {
    const id = crypto.randomUUID();
    const messageWithId = { ...message, id } as T;

    return new Promise<R>((resolve, reject) => {
      // Set up timeout
      const timeoutId = setTimeout(() => {
        if (this.messageHandlers.has(id)) {
          this.messageHandlers.delete(id);
          reject(new Error(`Request timed out after ${timeout}ms: ${message.type}`));
        }
      }, timeout);

      this.messageHandlers.set(id, { resolve, reject, timeout: timeoutId });
      this.worker.postMessage(messageWithId);
    });
  }

  /**
   * Initializes the KuzuDB database.
   * Must be called before any other operations.
   * 
   * @param dbData Optional persisted database data
   * @returns Promise that resolves when initialization is complete
   */
  async init(dbData?: ArrayBuffer): Promise<void> {
    await this.sendMessage<KuzuInitRequest, KuzuSuccessResponse>({
      type: 'init',
      dbData
    });
  }

  /**
   * Executes a read-only Cypher query against the database.
   * 
   * @param cypher The Cypher query to execute
   * @returns Promise that resolves with the query results
   */
  async query<T = any>(cypher: string): Promise<T> {
    const response = await this.sendMessage<KuzuQueryRequest, KuzuQuerySuccess>({
      type: 'query',
      cypher
    });

    // Parse the JSON result
    try {
      return response.data as T;
    } catch (error) {
      // If parsing fails, return the raw string data
      console.error("Error parsing query result:", error);
      return response.data as unknown as T;
    }
  }

  async queries(cypher: string[]): Promise<any[]> {
    if (cypher.length === 0) {
      return [];
    }
    // For a single statement, just use query
    if (cypher.length === 1) {
      return this.query(cypher[0]);
    }
    // wait for all promises to resolve
    return await Promise.all(cypher.map((statement) => this.query(statement)));
  }

  /**
   * Persists the database to storage.
   * 
   * @returns Promise that resolves with the serialized database files
   */
  async persist(): Promise<Record<string, string>> {
    const response = await this.sendMessage<KuzuPersistRequest, KuzuPersistSuccess>({
      type: 'persist'
    });

    return response.files;
  }

  /**
   * Executes a Cypher transaction containing multiple statements.
   * 
   * @param statements Array of Cypher statements to execute in a transaction
   * @returns Promise that resolves when the transaction is complete
   */
  async transaction(statements: string[]): Promise<any[]> {
    if (statements.length === 0) {
      return [];
    }

    // For a single statement, just use query
    if (statements.length === 1) {
      return this.query(statements[0]);
    }

    // For multiple statements, wrap in a transaction
    const transactionCypher = `
      BEGIN TRANSACTION;
      ${statements.join(';\n')};
      COMMIT;
    `;

    return this.query(transactionCypher);
  }

  /**
   * Checks if the database is operational.
   * 
   * @returns Promise that resolves with true if the database is working
   */
  async isHealthy(): Promise<boolean> {
    try {
      await this.query('RETURN 1 as test');
      return true;
    } catch (error) {
      console.error('Database health check failed:', error);
      return false;
    }
  }

  /**
   * Closes the connection to the database and terminates the worker.
   * Should be called when the database is no longer needed.
   */
  async close(): Promise<void> {
    try {
      // Try to persist the database before closing
      await this.persist();
    } catch (error) {
      console.error('Error persisting database during close:', error);
    } finally {
      // Clear all pending requests
      for (const [id, handler] of this.messageHandlers.entries()) {
        clearTimeout(handler.timeout);
        handler.reject(new Error('Worker terminated'));
        this.messageHandlers.delete(id);
      }

      this.worker.terminate();
    }
  }
}