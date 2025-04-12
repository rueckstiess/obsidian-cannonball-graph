import { KuzuClient } from './kuzu-client';
import { Notice, App, Plugin, TFile, Pos, ListItemCache, BlockCache } from 'obsidian';

interface FileEntry {
  file: TFile;
  content: string;
  mtime: number;
  blocks: Array<{
    display: string;
    node: {
      id?: string,
      type: string,
      position: Pos,
      children: Array<any>,
    }
  }>;
}


/**
 * Declaration merging to add Obsidian's undocumented cache properties
 */
declare module 'obsidian' {
  interface MetadataCache {
    // The block cache containing detailed block information
    blockCache: {
      getForFile: (cancelContext: any, file: TFile) => Promise<FileEntry>,
      cache: Record<string, {
        file: TFile;
        content: string;
        mtime: number;
        blocks: Array<{
          display: string;
          type: string;
          position: Pos;
          id?: string;
        }>;
      }>;
    };

    // Internal file cache mapping paths to file metadata
    fileCache: Record<string, {
      hash: string;
      mtime: number;
      size: number;
    }>;

    // Internal metadata cache mapping hashes to full metadata
    metadataCache: Record<string, {
      headings?: HeadingCache[];
      blocks?: Record<string, BlockCache>;
      links?: any[];
      embeds?: any[];
      tags?: any[];
      frontmatter?: any;
      sections?: any[];
      listItems?: ListItemCache[];
    }>;
  }
}

/**
 * Service class for converting Obsidian's block cache to graph database nodes and relationships.
 * Handles the complexity of mapping Obsidian blocks to a graph structure.
 */
export class ObsidianCacheGraphService {
  private kuzuClient: KuzuClient;
  private plugin: Plugin;
  private app: App;
  private nodeIdCounter = 0;
  private isReady = false;
  private fileToNodeMap: Map<string, Map<string, string>> = new Map();

  /**
   * Creates a new ObsidianCacheGraphService
   * 
   * @param plugin The Obsidian plugin instance
   * @param kuzuClient The KuzuDB client instance to use
   */
  constructor(plugin: Plugin, kuzuClient: KuzuClient) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.kuzuClient = kuzuClient;

    // Initialize the schema when plugin loads
    this.initSchema().then(() => {
      // Register for metadata cache events
      this.registerEvents();
    });
  }


  /**
   * Register events for metadata cache changes
   */
  private registerEvents(): void {
    // Process individual files when their metadata changes
    this.plugin.registerEvent(
      this.app.metadataCache.on('changed', (file, data, cache) => {
        console.log(`Metadata changed for ${file.path}, data ${data}, cache ${cache}, processing...`);
        console.log(cache);
        new Notice(`Processing ${file.path}...`);
        this.processFile(file);
      })
    );
  }


  /**
 * Gets all blocks from a specific file using the blockCache's getForFile method
 * @param {string} filePath - The path of the file to get blocks from
 * @returns {Promise<Array>} - Array of blocks with added context
 */
  private async getBlocksForFile(filePath: string): Promise<any[]> {
    // Get the file object from the path
    const file: TFile = this.app.vault.getAbstractFileByPath(filePath) as TFile;

    // Check if file exists and is a markdown file
    if (!file || file.extension !== "md") {
      console.error(`File not found or not markdown: ${filePath}`);
      return [];
    }

    // Create cancel context for Obsidian's API
    const cancelContext: { isCancelled: () => boolean } = {
      isCancelled: () => false
    };

    try {
      // Get blocks using the getForFile method
      const fileEntry = await this.app.metadataCache.blockCache.getForFile(cancelContext, file);

      // If no blocks were found or processing was cancelled
      if (!fileEntry || ('blocks' in fileEntry && !fileEntry.blocks)) {
        console.log(`No blocks found for file: ${filePath}`);
        return [];
      }

      // Add file context to each block
      // const blocksWithContext = fileEntry.blocks.map((block: BlockCache) => ({
      //   ...block,
      //   filePath: file.path,
      //   fileName: file.name
      // }));

      return fileEntry.blocks;
    } catch (error) {
      console.error(`Error getting blocks for file ${filePath}:`, error);
      return [];
    }
  }







  /**
   * Initialize the graph schema for block nodes.
   * Creates necessary node and relationship tables.
   */
  public async initSchema(): Promise<void> {
    await this.kuzuClient.transaction([
      // Drop existing tables if they exist
      'DROP TABLE IF EXISTS LINK',
      'DROP TABLE IF EXISTS Block',

      // Node table for blocks
      `CREATE NODE TABLE Block (
        id STRING,           // unique identifier for the block
        blockId STRING,      // Obsidian's block ID if available
        type STRING,         // e.g. "heading", "paragraph", "listItem", etc.
        text STRING,         // raw content
        level INT32,         // for headings, lists, etc.
        path STRING,         // file path
        line INT32,          // line number in file
        PRIMARY KEY(id)
      )`,

      // Edge table for relationships
      `CREATE REL TABLE LINK (
        FROM Block TO Block,
        type STRING,         // e.g. "CONTAINS", "REFERENCES", etc.
        rank INT32           // for ordering
      )`
    ]);

    this.isReady = true;
  }

  /**
   * Index all files in the vault
   */
  public async indexVault(): Promise<void> {
    if (!this.isReady) {
      await this.initSchema();
    }

    console.log('Starting full vault indexing');

    // Get all markdown files
    const files = this.app.vault.getMarkdownFiles();
    console.log(`Found ${files.length} markdown files to index`);

    // Process files in batches to avoid overwhelming the system
    const batchSize = 10;
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);

      // Process each file in the batch
      await Promise.all(batch.map(file => this.processFile(file)));

      // Optional: show progress notification
      new Notice(`Indexed ${Math.min(i + batchSize, files.length)} of ${files.length} files`);

      // Give the UI time to breathe between batches
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    console.log('Vault indexing complete');
    new Notice('Graph indexing complete!');
  }

  /**
   * Process a file and add its blocks to the graph database.
   * 
   * @param file The file to process
   * @returns Promise that resolves when processing is complete
   */
  public async processFile(file: TFile): Promise<void> {
    if (!this.isReady) {
      await this.initSchema();
    }

    try {
      // get metadata from file cache
      const metadata = this.app.metadataCache.getFileCache(file);

      if (!metadata) {
        console.warn(`No metadata found for file: ${file.path}`);
        return;
      }

      const blocks = await this.getBlocksForFile(file.path);
      console.log(blocks);

      // // Clear existing nodes for this file
      // await this.kuzuClient.query(`
      //   MATCH (b:Block {path: '${this.escapeCypher(file.path)}'})
      //   DETACH DELETE b
      // `);

      // // Reset the file's node map
      // const fileNodeMap = new Map<string, string>();
      // this.fileToNodeMap.set(file.path, fileNodeMap);

      // // Process sections, headings, and blocks
      // const createNodeStatements: string[] = [];

      // Process headings from metadata
      // if (metadata.headings) {
      //   for (const heading of metadata.headings) {
      //     const nodeId = `heading-${this.getNodeId()}`;
      //     const positionKey = this.getPositionKey(heading.position);
      //     fileNodeMap.set(positionKey, nodeId);

      //     createNodeStatements.push(`
      //       CREATE (:Block {
      //         id: '${nodeId}',
      //         type: 'heading',
      //         text: '${this.escapeCypher(heading.heading)}',
      //         level: ${heading.level},
      //         path: '${this.escapeCypher(file.path)}',
      //         line: ${heading.position.start.line}
      //       })
      //     `);
      //   }
      // }

      // Process lists from metadata
      // if (metadata.listItems) {
      //   for (const listItem of metadata.listItems) {
      //     const nodeId = `listItem-${this.getNodeId()}`;
      //     const positionKey = this.getPositionKey(listItem.position);
      //     fileNodeMap.set(positionKey, nodeId);

      //     // Determine if this is a task and its status
      //     // const isTask = listItem.task !== undefined;
      //     const level = this.calculateListItemLevel(listItem);

      //     // Get content from block cache
      //     const content = this.getBlockContentByPosition(blocks, listItem.position);

      //     createNodeStatements.push(`
      //       CREATE (:Block {
      //         id: '${nodeId}',
      //         type: 'listItem',
      //         text: '${this.escapeCypher(content)}',
      //         level: ${level},
      //         path: '${this.escapeCypher(file.path)}',
      //         line: ${listItem.position.start.line}
      //       })
      //     `);
      //   }
      // }

      // Process blocks with IDs from metadata
      // if (blocks) {
      //   for (const [blockId, blockInfo] of Object.entries(blocks)) {
      //     const nodeId = `block-${this.getNodeId()}`;
      //     const positionKey = this.getPositionKey(blockInfo.node.position);
      //     fileNodeMap.set(positionKey, nodeId);

      //     // Get block content from the blockCache
      //     const content = this.getBlockContentByPosition(blocks, blockInfo.node.position);

      //     // Try to determine block type from the block cache
      //     const blockCacheEntry = this.findBlockByPosition(blocks, blockInfo.node.position);
      //     const blockType = blockCacheEntry?.type || 'block';

      //     createNodeStatements.push(`
      //       CREATE (:Block {
      //         id: '${nodeId}',
      //         blockId: '${this.escapeCypher(blockId)}',
      //         type: '${blockType}',
      //         text: '${this.escapeCypher(content)}',
      //         path: '${this.escapeCypher(file.path)}',
      //         line: ${(blockInfo as BlockCache).position.start.line}
      //       })
      //     `);
      //   }
      // }

      // // Execute create node statements
      // if (createNodeStatements.length > 0) {
      //   await this.kuzuClient.transaction(createNodeStatements);
      // }

      // Now process relationships
      // await this.createRelationships(file, metadata, blockCache, fileNodeMap);

    } catch (error) {
      console.error(`Error processing file ${file.path}:`, error);
    }
  }

  /**
   * Create relationships between blocks in the graph.
   * This will be implemented in step 2.
   */
  private async createRelationships(
    file: TFile,
    metadata: any,
    blockCache: any,
    fileNodeMap: Map<string, string>
  ): Promise<void> {
    // PLACEHOLDER FOR STEP 2: Relationship creation logic
    // This will include:
    // - Hierarchical containment relationships
    // - Reference relationships from links
    // - Custom relationships based on content analysis
  }


  /**
   * Gets a unique node ID for the current processing session
   */
  private getNodeId(): number {
    return this.nodeIdCounter++;
  }

  /**
   * Escapes a string for safe use in Cypher queries
   */
  private escapeCypher(value: string): string {
    if (!value) return "";
    return value.replace(/'/g, "\\'");
  }

  /**
   * Runs a query to find blocks matching specific criteria
   * 
   * @param type Block type to query for
   * @param properties Additional properties to match
   * @returns The query results
   */
  public async queryBlocks(type: string, properties: Record<string, any> = {}): Promise<any[]> {
    let whereClause = '';

    if (Object.keys(properties).length > 0) {
      const conditions = Object.entries(properties)
        .map(([key, value]) => {
          if (typeof value === 'string') {
            return `n.${key} = '${this.escapeCypher(value)}'`;
          }
          return `n.${key} = ${value}`;
        })
        .join(' AND ');

      whereClause = `WHERE ${conditions}`;
    }

    const query = `
      MATCH (n:Block) 
      WHERE n.type = '${type}'
      ${whereClause ? 'AND ' + whereClause : ''}
      RETURN n 
      LIMIT 100
    `;

    return await this.kuzuClient.query(query);
  }

  /**
   * Runs a query to find relationships between blocks
   * 
   * @param fromType Source block type
   * @param relType Relationship type
   * @param toType Target block type
   * @returns The query results
   */
  public async queryBlockRelationships(fromType: string, relType: string, toType: string): Promise<any[]> {
    const query = `
      MATCH (a:Block)-[r:LINK {type: '${this.escapeCypher(relType)}'}]->(b:Block)
      WHERE a.type = '${this.escapeCypher(fromType)}' AND b.type = '${this.escapeCypher(toType)}'
      RETURN a, r, b
      LIMIT 100
    `;

    return await this.kuzuClient.query(query);
  }

  /**
   * Reset the internal state of the service
   */
  public reset(): void {
    this.nodeIdCounter = 0;
    this.fileToNodeMap.clear();
  }
}