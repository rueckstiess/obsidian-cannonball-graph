/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-non-null-assertion */

import { jest, describe, it, expect, beforeAll, beforeEach, afterAll } from '@jest/globals';
import { KuzuClient } from '../src/kuzu-client';
import type {
  KuzuResponse,
  KuzuErrorResponse,
  KuzuQuerySuccess,
  KuzuInitSuccess,
  KuzuPersistSuccess
} from '../src/kuzu-messages';

// Mock implementation of Worker
class MockWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((error: { message: string, type: string }) => void) | null = null;
  private messageQueue: MessageEvent[] = [];
  private errorQueue: { message: string, type: string }[] = [];

  constructor() { }

  postMessage(data: any): void {
    // Store the request ID for responding later
    this.lastRequestId = data.id;
    this.lastRequestType = data.type;
    this.requests.push(data);
  }

  // Test helpers
  lastRequestId: string | null = null;
  lastRequestType: string | null = null;
  requests: any[] = [];

  // Helper methods for tests to trigger responses
  respondWith(response: KuzuResponse): void {
    if (this.onmessage) {
      this.onmessage(new MessageEvent('message', { data: response }));
    } else {
      this.messageQueue.push(new MessageEvent('message', { data: response }));
    }
  }

  respondWithError(error: string): void {
    if (this.onmessage) {
      const errorResponse: KuzuErrorResponse = {
        id: this.lastRequestId || '',
        type: 'error',
        error,
        requestType: this.lastRequestType || '',
      };
      this.onmessage(new MessageEvent('message', { data: errorResponse }));
    }
  }

  emitError(error: string): void {
    const errorObj = { message: error, type: 'error' };
    if (this.onerror) {
      this.onerror(errorObj);
    } else {
      this.errorQueue.push(errorObj);
    }
  }

  // Process queued messages/errors once handlers are set
  processQueue(): void {
    if (this.onmessage) {
      this.messageQueue.forEach(event => this.onmessage!(event));
      this.messageQueue = [];
    }

    if (this.onerror) {
      this.errorQueue.forEach(error => this.onerror!(error));
      this.errorQueue = [];
    }
  }

  terminate(): void {
    // Clear everything
    this.onmessage = null;
    this.onerror = null;
    this.messageQueue = [];
    this.errorQueue = [];
    this.lastRequestId = null;
    this.lastRequestType = null;
    this.requests = [];
  }
}

// Mocking crypto.randomUUID
const originalRandomUUID = crypto.randomUUID;
beforeAll(() => {
  // Replace randomUUID with a predictable implementation for tests
  let counter = 0;
  (crypto.randomUUID as any) = jest.fn().mockImplementation(() => `mock-uuid-${counter++}`);
});

afterAll(() => {
  // Restore original implementation
  crypto.randomUUID = originalRandomUUID;
});

describe('KuzuClient', () => {
  let client: KuzuClient;
  let mockWorker: MockWorker;

  beforeEach(() => {
    mockWorker = new MockWorker();
    // Pass the MockWorker constructor as a parameter
    client = new KuzuClient(MockWorker as unknown as new () => Worker);
    // Get the instance that was created inside KuzuClient
    mockWorker = (client as any).worker as MockWorker;
  });

  describe('constructor', () => {
    it('should initialize with a worker', () => {
      expect(client).toBeDefined();
      expect((client as any).worker).toBeInstanceOf(MockWorker);
      expect((client as any).messageHandlers).toBeInstanceOf(Map);
    });
  });

  describe('sendMessage', () => {
    it('should send message to worker and resolve promise on success', async () => {
      const sendPromise = (client as any).sendMessage({ type: 'test' });

      // The worker should have received the message
      expect(mockWorker.lastRequestType).toBe('test');
      expect(mockWorker.requests.length).toBe(1);
      expect(mockWorker.requests[0].id).toBe('mock-uuid-0');

      // Mock a successful response
      mockWorker.respondWith({
        id: 'mock-uuid-0',
        type: 'init-success'
      });

      // Promise should resolve
      await expect(sendPromise).resolves.toEqual({
        id: 'mock-uuid-0',
        type: 'init-success'
      });
    });

    it('should reject promise on error response', async () => {
      const sendPromise = (client as any).sendMessage({ type: 'test' });

      // Mock an error response
      mockWorker.respondWithError('Test error');

      // Promise should reject
      await expect(sendPromise).rejects.toThrow('test failed: Test error');
    });

    it('should reject promise on timeout', async () => {
      // Use a very short timeout for testing
      const sendPromise = (client as any).sendMessage({ type: 'test' }, 10);

      // Wait for the timeout to occur naturally
      await expect(sendPromise).rejects.toThrow('Request timed out after 10ms: test');
    });

    it('should reject all promises on worker error', async () => {
      const sendPromise1 = (client as any).sendMessage({ type: 'test1' });
      const sendPromise2 = (client as any).sendMessage({ type: 'test2' });

      // Simulate a worker error
      mockWorker.emitError('Worker crashed');

      // Both promises should reject
      await expect(sendPromise1).rejects.toThrow('Worker error: Worker crashed');
      await expect(sendPromise2).rejects.toThrow('Worker error: Worker crashed');
    });
  });

  describe('init', () => {
    it('should initialize the database', async () => {
      const initPromise = client.init();

      // Verify the request
      expect(mockWorker.lastRequestType).toBe('init');

      // Mock successful response
      mockWorker.respondWith({
        id: mockWorker.lastRequestId!,
        type: 'init-success'
      } as KuzuInitSuccess);

      await expect(initPromise).resolves.toBeUndefined();
    });

    it('should initialize with database data', async () => {
      const dbData = new ArrayBuffer(8);
      const initPromise = client.init(dbData);

      // Verify the request includes dbData
      expect(mockWorker.requests[0].dbData).toBe(dbData);

      // Mock successful response
      mockWorker.respondWith({
        id: mockWorker.lastRequestId!,
        type: 'init-success'
      } as KuzuInitSuccess);

      await expect(initPromise).resolves.toBeUndefined();
    });
  });

  describe('query', () => {
    it('should execute a query and return array results', async () => {
      const testQuery = 'MATCH (n) RETURN n LIMIT 10';
      const queryResults = [{ test: 1 }]; // Array instead of JSON string

      const queryPromise = client.query(testQuery);

      // Verify the request
      expect(mockWorker.lastRequestType).toBe('query');
      expect(mockWorker.requests[0].cypher).toBe(testQuery);

      // Mock successful response with array data
      mockWorker.respondWith({
        id: mockWorker.lastRequestId!,
        type: 'query-success',
        data: queryResults
      } as KuzuQuerySuccess);

      await expect(queryPromise).resolves.toEqual([{ test: 1 }]);
    });

    it('should handle empty result sets', async () => {
      const testQuery = 'MATCH (n) RETURN n';
      const emptyResults: Record<string, any>[] = [];

      const queryPromise = client.query(testQuery);

      // Mock successful response with empty array
      mockWorker.respondWith({
        id: mockWorker.lastRequestId!,
        type: 'query-success',
        data: emptyResults
      } as KuzuQuerySuccess);

      // Should return empty array
      await expect(queryPromise).resolves.toEqual([]);
    });
  });

  describe('persist', () => {
    it('should persist database and return files', async () => {
      const testFiles = { 'db.file1': 'content1', 'db.file2': 'content2' };
      const persistPromise = client.persist();

      // Verify the request
      expect(mockWorker.lastRequestType).toBe('persist');

      // Mock successful response
      mockWorker.respondWith({
        id: mockWorker.lastRequestId!,
        type: 'persist-success',
        files: testFiles
      } as KuzuPersistSuccess);

      await expect(persistPromise).resolves.toEqual(testFiles);
    });
  });

  describe('transaction', () => {
    it('should do nothing for empty statements array', async () => {
      await client.transaction([]);
      expect(mockWorker.requests.length).toBe(0);
    });

    it('should wrap multiple statements in a transaction', async () => {
      const stmts = [
        'CREATE (n:Test1)',
        'CREATE (n:Test2)'
      ];

      const transactionPromise = client.transaction(stmts);

      // Should use query with transaction wrapper
      expect(mockWorker.lastRequestType).toBe('query');
      expect(mockWorker.requests[0].cypher).toContain('BEGIN TRANSACTION');
      expect(mockWorker.requests[0].cypher).toContain('COMMIT');
      expect(mockWorker.requests[0].cypher).toContain(stmts[0]);
      expect(mockWorker.requests[0].cypher).toContain(stmts[1]);

      mockWorker.respondWith({
        id: mockWorker.lastRequestId!,
        type: 'query-success'
      } as KuzuQuerySuccess);

      await expect(transactionPromise).resolves.toBeUndefined();
    });
  });

  describe('isHealthy', () => {
    it('should return true if test query succeeds', async () => {
      const healthCheckPromise = client.isHealthy();

      // Verify query is sent
      expect(mockWorker.lastRequestType).toBe('query');
      expect(mockWorker.requests[0].cypher).toBe('RETURN 1 as test');

      // Mock successful response
      mockWorker.respondWith({
        id: mockWorker.lastRequestId!,
        type: 'query-success',
        data: [{ "test": 1 }]
      } as KuzuQuerySuccess);

      await expect(healthCheckPromise).resolves.toBe(true);
    });

    it('should return false if test query fails', async () => {
      const healthCheckPromise = client.isHealthy();

      // Mock error response
      mockWorker.respondWithError('Database not ready');

      await expect(healthCheckPromise).resolves.toBe(false);
    });
  });

  describe('close', () => {
    it('should attempt to persist and terminate worker', async () => {
      // Mock console.error for the error case
      const originalConsoleError = console.error;
      console.error = jest.fn();

      const closePromise = client.close();

      // Should try to persist first
      expect(mockWorker.lastRequestType).toBe('persist');

      // Mock successful persist response
      mockWorker.respondWith({
        id: mockWorker.lastRequestId!,
        type: 'persist-success',
        files: {}
      } as KuzuPersistSuccess);

      await closePromise;

      // Worker should be terminated
      expect(console.error).not.toHaveBeenCalled();

      // Restore console.error
      console.error = originalConsoleError;
    });

    it('should handle persist errors during close', async () => {
      // Mock console.error
      const originalConsoleError = console.error;
      console.error = jest.fn();

      const closePromise = client.close();

      // Mock error during persist
      mockWorker.respondWithError('Persist failed');

      await closePromise;

      // Should log error but still terminate
      expect(console.error).toHaveBeenCalled();

      // Restore console.error
      console.error = originalConsoleError;
    });
  });

  describe('queries', () => {
    it('should handle empty array input', async () => {
      const result = await client.queries([]);
      expect(result).toEqual([]);
      expect(mockWorker.requests.length).toBe(0);
    });

    it('should use query method for single statement', async () => {
      const testQuery = 'MATCH (n) RETURN n';
      const queriesPromise = client.queries([testQuery]);

      // Should use the single query method
      expect(mockWorker.lastRequestType).toBe('query');
      expect(mockWorker.requests[0].cypher).toBe(testQuery);

      // Mock successful response
      mockWorker.respondWith({
        id: mockWorker.lastRequestId!,
        type: 'query-success',
        data: [{ test: 1 }]
      } as KuzuQuerySuccess);

      await expect(queriesPromise).resolves.toEqual([{ test: 1 }]);
    });

    it('should execute multiple queries in parallel', async () => {
      const testQueries = [
        'MATCH (n:Type1) RETURN n',
        'MATCH (n:Type2) RETURN n'
      ];

      // Start the queries process
      const queriesPromise = client.queries(testQueries);

      // Should have sent two separate queries
      expect(mockWorker.requests.length).toBe(2);
      expect(mockWorker.requests[0].cypher).toBe(testQueries[0]);
      expect(mockWorker.requests[1].cypher).toBe(testQueries[1]);

      // Mock successful responses with correct data types
      mockWorker.respondWith({
        id: mockWorker.requests[0].id,
        type: 'query-success',
        data: [{ result: 'type1' }]
      } as KuzuQuerySuccess);

      mockWorker.respondWith({
        id: mockWorker.requests[1].id,
        type: 'query-success',
        data: [{ result: 'type2' }]
      } as KuzuQuerySuccess);

      // Wait for the result and verify
      const results = await queriesPromise;

      // Check that results contain both query responses as arrays in an array
      expect(results).toEqual([
        [{ result: 'type1' }],
        [{ result: 'type2' }]
      ]);

      // Verify that results match the expected format - an array of arrays
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(2);
      expect(Array.isArray(results[0])).toBe(true);
      expect(Array.isArray(results[1])).toBe(true);
    });
  });
});