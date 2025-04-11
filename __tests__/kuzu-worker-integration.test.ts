/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-non-null-assertion */


import { jest, describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from '@jest/globals';
import { KuzuClient } from '../src/kuzu-client';
import type { KuzuResponse } from '../src/kuzu-messages';


// This test file focuses on testing the client's interactions with a mock worker
// that more closely simulates real worker behavior

class MockKuzuWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((error: ErrorEvent) => void) | null = null;

  constructor() {
    // Set up automatic responses for testing
    setTimeout(() => this.setupAutoResponses(), 0);
  }

  postMessage(data: any): void {
    // Process message asynchronously to better simulate real worker behavior
    setTimeout(() => this.processMessage(data), 0);
  }

  private setupAutoResponses(): void {
    // Nothing to do, just simulating worker setup
  }

  private processMessage(data: any): void {
    if (!this.onmessage) return;

    const { id, type } = data;

    // Simulate worker processing
    setTimeout(() => {
      let response: KuzuResponse;

      switch (type) {
        case 'init':
          response = {
            id,
            type: 'init-success'
          };
          break;

        case 'query':
          if (data.cypher === 'RETURN 1 as test') {
            response = {
              id,
              type: 'query-success',
              data: JSON.stringify({ test: 1 })
            };
          } else if (data.cypher.includes('ERROR')) {
            response = {
              id,
              type: 'error',
              error: 'Query syntax error',
              requestType: 'query'
            };
          } else {
            // Simulate a normal query result
            response = {
              id,
              type: 'query-success',
              data: JSON.stringify({ results: [{ example: 'data' }] })
            };
          }
          break;

        case 'persist':
          response = {
            id,
            type: 'persist-success',
            files: {
              'db.file1': 'test-content-1',
              'db.file2': 'test-content-2'
            }
          };
          break;

        default:
          response = {
            id,
            type: 'error',
            error: `Unknown request type: ${type}`,
            requestType: type
          };
      }

      // Send the response back
      this.onmessage!(new MessageEvent('message', { data: response }));
    }, 10); // Small delay to simulate processing time
  }

  terminate(): void {
    this.onmessage = null;
    this.onerror = null;
  }
}

// Mock crypto.randomUUID for consistent IDs in tests
const originalRandomUUID = crypto.randomUUID;
beforeAll(() => {
  (crypto.randomUUID as any) = jest.fn().mockImplementation(() =>
    Math.random().toString(36).substring(2, 15) +
    Math.random().toString(36).substring(2, 15)
  );
});

afterAll(() => {
  crypto.randomUUID = originalRandomUUID;
});

describe('KuzuClient Integration Tests', () => {
  let client: KuzuClient;

  beforeEach(() => {
    client = new KuzuClient(MockKuzuWorker as unknown as new () => Worker);
  });

  afterEach(async () => {
    try {
      await client.close();
    } catch (e) {
      // Ignore errors during cleanup
      console.log('Cleanup error:', e);
    }
  });

  it('should initialize and execute a query', async () => {
    await client.init();
    const results = await client.query('MATCH (n) RETURN n');
    expect(results).toEqual({ results: [{ example: 'data' }] });
  });

  it('should handle errors in query execution', async () => {
    await client.init();
    await expect(client.query('ERROR in query')).rejects.toThrow('Query syntax error');
  });

  it('should execute a query statement successfully', async () => {
    await client.init();

    const result = await client.query('CREATE (n:Test)')
    expect(result).toBeDefined();
  });

  it('should handle transaction with multiple statements', async () => {
    await client.init();
    await expect(client.transaction([
      'CREATE (n:Test1)',
      'CREATE (n:Test2)'
    ])).resolves.toBeDefined();
  });

  it('should persist and return database files', async () => {
    await client.init();
    const files = await client.persist();
    expect(Object.keys(files)).toContain('db.file1');
    expect(Object.keys(files)).toContain('db.file2');
  });

  it('should report database health correctly', async () => {
    await client.init();
    const isHealthy = await client.isHealthy();
    expect(isHealthy).toBe(true);
  });
});