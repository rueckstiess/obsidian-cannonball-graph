// __tests__/kuzu-client-delete-existing-nodes.test.ts
import { ObsidianCacheGraphService } from '../src/ObsidianCacheGraphService';
import { KuzuClient } from '../src/kuzu-client';
import { jest } from '@jest/globals';

// Create mock functions
const mockQuery = jest.fn();
const mockTransaction = jest.fn();

// Create the mock client with the mock functions
const mockKuzuClient = {
  query: mockQuery,
  transaction: mockTransaction
} as unknown as KuzuClient;

// Create mock plugin
const mockPlugin = {
  app: {
    vault: {
      getAbstractFileByPath: jest.fn()
    },
    metadataCache: {
      on: jest.fn(),
      getFileCache: jest.fn()
    }
  },
  registerEvent: jest.fn()
} as any;

describe('ObsidianCacheGraphService', () => {
  let service: ObsidianCacheGraphService;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Create service instance with mocked dependencies
    service = new ObsidianCacheGraphService(mockPlugin, mockKuzuClient);

    // Make the private method accessible for testing
    // @ts-ignore - accessing private method for testing
    service.testDeleteExistingNodes = service.deleteExistingNodes;
  });

  describe('deleteExistingNodes', () => {
    it('should generate correct Cypher query for file path', async () => {
      // Sample file path
      const filePath = 'test/path/to/file.md';

      // Call the method
      // @ts-ignore - accessing private method for testing
      await service.testDeleteExistingNodes(filePath);

      // Check that the query was called with the correct Cypher statement
      expect(mockQuery).toHaveBeenCalledTimes(1);

      const queryArg = mockQuery.mock.calls[0][0];
      expect(queryArg).toContain(`MATCH (b:Block {path: 'test/path/to/file.md'})`);
      expect(queryArg).toContain('DETACH DELETE b');
    });

    it('should escape special characters in file path', async () => {
      // Sample file path with characters that need escaping
      const filePath = "test/path/with'quote.md";

      // Call the method
      // @ts-ignore - accessing private method for testing
      await service.testDeleteExistingNodes(filePath);

      // Check that the query was called with properly escaped path
      const queryArg = mockQuery.mock.calls[0][0];
      expect(queryArg).toContain(`MATCH (b:Block {path: 'test/path/with\\'quote.md'})`);
    });
  });
});