import { KuzuClient } from './kuzu-client';
import { Notice, App, Plugin, TFile, Pos, ListItemCache, BlockCache } from 'obsidian';

interface Block {

  display: string;
  node: {
    type: string,
    position: Pos,
    children: Array<any>,
  }
}

interface FileEntry {
  file: TFile;
  content: string;
  mtime: number;
  blocks: Array<Block>;
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
  private isReady = false;

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
  private async getBlocksForFile(filePath: string): Promise<Block[]> {
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
      'DROP TABLE IF EXISTS Link',
      'DROP TABLE IF EXISTS HasTag',
      'DROP TABLE IF EXISTS Tag',
      'DROP TABLE IF EXISTS Block',

      // Block Table - Represents all node types in the graph
      `CREATE NODE TABLE Block(
        id STRING PRIMARY KEY,   // Unique identifier (file path + position or block ID)
        type STRING,             // "note", "heading", "paragraph", "task", "decision", "folder", "vault", etc.
        status STRING,           // For stateful nodes: "open", "completed", "blocked", etc.
        content STRING,          // Text content of the node
        path STRING,             // File path (empty for vault node)
        start_line INT32,        // Start line in the file (for block-level nodes)
        start_col INT32,         // Start column in the file
        end_line INT32,          // End line in the file
        end_col INT32,           // End column in the file
        block_id STRING,         // Optional block ID (^block-id)
        tags STRING[],           // Array of tags associated with this node
        depth INT32,             // For hierarchical nodes like headings (h1=1, h2=2) or list nesting
        created_at TIMESTAMP,    // When this node was first created
        updated_at TIMESTAMP     // When this node was last updated
      )`,

      // Relationship Table - Represents all relationships between blocks
      `CREATE REL TABLE Link(
        FROM Block TO Block,
        type STRING,             // "contains", "belongs_to", "depends_on", "links_to", etc.
        explicit BOOLEAN,        // Whether this relationship was explicitly defined
        rank INT32,              // For ordering relationships
        created_at TIMESTAMP,    // When this relationship was first created
        updated_at TIMESTAMP     // When this relationship was last updated
      )`,
      // Tag Table for more efficient tag queries
      `CREATE NODE TABLE Tag(
        id STRING PRIMARY KEY,   // Tag name with # prefix
        name STRING,             // Tag name without # prefix
        category STRING          // For hierarchical tags like #project/personal
      )`,

      // Tag relationships
      `CREATE REL TABLE HasTag(
        FROM Block TO Tag,
        created_at TIMESTAMP
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
  // public async processFile(file: TFile): Promise<void> {
  //   if (!this.isReady) {
  //     await this.initSchema();
  //   }

  //   try {
  //     // get metadata from file cache
  //     const metadata = this.app.metadataCache.getFileCache(file);

  //     if (!metadata) {
  //       console.warn(`No metadata found for file: ${file.path}`);
  //       return;
  //     }

  //     const blocks = await this.getBlocksForFile(file.path);
  //     console.log(metadata);
  //     console.log(blocks);

  //     // Clear existing nodes for this file
  //     await this.kuzuClient.query(`
  //       MATCH (b:Block {path: '${this.escapeCypher(file.path)}'})
  //       DETACH DELETE b
  //     `);


  //   } catch (error) {
  //     console.error(`Error processing file ${file.path}:`, error);
  //   }
  // }


  // Process file structure
  public async processFile(file: TFile): Promise<void> {
    // Get caches
    const metadata = this.app.metadataCache.getFileCache(file);
    const blocks = await this.getBlocksForFile(file.path);

    // Delete existing nodes for this file
    this.deleteExistingNodes(file.path);

    // Create or ensure vault and folder nodes exist
    this.ensureVaultAndFolderNodes(file.path);

    // Create file node
    this.createFileNode(file);

    // Process sections and create nodes
    const nodeStatements = [];
    const relationshipStatements = [];

    if (!metadata) {
      console.warn(`No metadata found for file: ${file.path}`);
      return;
    }

    // Process headings
    if (metadata.headings) {
      for (const heading of metadata.headings) {
        const headingId = this.generateNodeId(file.path, heading.position);
        nodeStatements.push(this.createHeadingNodeStatement(headingId, heading, file.path));

        // Add relationship to file
        relationshipStatements.push(this.createRelationshipStatement(
          this.generateFileId(file.path),
          headingId,
          'contains'
        ));
      }
    }

    // Process list items (with parent-child relationships)
    if (metadata.listItems) {
      const listItemMap = new Map(); // Map parent IDs to node IDs

      for (const listItem of metadata.listItems) {
        const listItemId = this.generateNodeId(file.path, listItem.position);
        const itemType = this.determineListItemType(listItem, blocks);

        nodeStatements.push(this.createListItemNodeStatement(listItemId, listItem, itemType, file.path));

        // Add relationship based on parent
        if (listItem.parent < 0) {
          // Top-level item, connected to file or nearest heading
          const parentId = this.findContainerForPosition(listItem.position, metadata.headings, file.path);
          relationshipStatements.push(this.createRelationshipStatement(
            parentId,
            listItemId,
            'contains'
          ));
        } else {
          // Child item, connected to parent list item
          const parentNodeId = listItemMap.get(listItem.parent);
          relationshipStatements.push(this.createRelationshipStatement(
            parentNodeId,
            listItemId,
            'contains'
          ));
        }

        // Store this item's ID for child references
        listItemMap.set(listItem.position.start.line, listItemId);
      }
    }

    // Process other sections (paragraphs, code blocks, etc.)
    if (metadata.sections) {
      for (const section of metadata.sections) {
        if (this.isProcessableSection(section.type)) {
          const sectionId = this.generateNodeId(file.path, section.position);

          // Find block content from block cache
          const blockContent = this.findBlockContent(section, blocks);

          nodeStatements.push(this.createSectionNodeStatement(
            sectionId,
            section,
            blockContent,
            file.path
          ));

          // Add relationship to container
          const parentId = this.findContainerForPosition(section.position, metadata.headings, file.path);
          relationshipStatements.push(this.createRelationshipStatement(
            parentId,
            sectionId,
            'contains'
          ));
        }
      }
    }

    // Process explicit links
    if (metadata.links) {
      for (const link of metadata.links) {
        const sourceNodeId = this.findNodeContainingPosition(link.position, metadata);
        const targetNodeId = this.resolveLink(link.link, metadata);

        if (sourceNodeId && targetNodeId) {
          relationshipStatements.push(this.createRelationshipStatement(
            sourceNodeId,
            targetNodeId,
            'links_to'
          ));
        }
      }
    }

    // Execute all statements
    await this.kuzuClient.transaction([...nodeStatements, ...relationshipStatements]);
  }


  /**
   * Escapes a string for safe use in Cypher queries.
   * 
   * @param value The string to escape
   * @returns The escaped string
   */
  private escapeCypher(value: string): string {
    if (!value) return '';
    return value.replace(/'/g, "\\'");
  }

  /**
   * Deletes all nodes and their relationships associated with a specific file path.
   * 
   * @param filePath The path of the file whose nodes should be deleted
   * @returns Promise that resolves when the deletion is complete
   */
  private async deleteExistingNodes(filePath: string): Promise<void> {
    try {
      // Escape any special characters in the file path for Cypher
      const escapedPath = this.escapeCypher(filePath);

      // Create a Cypher query to detach and delete all nodes with this path
      const query = `
      MATCH (b:Block {path: '${escapedPath}'})
      DETACH DELETE b
    `;

      // Execute the query
      await this.kuzuClient.query(query);

      console.log(`Deleted nodes for file: ${filePath}`);
    } catch (error) {
      console.error(`Error deleting nodes for file ${filePath}:`, error);
      throw error;
    }
  }

  /**
   * Ensures that vault and folder nodes exist in the graph structure.
   * Creates them if they don't exist.
   * 
   * @param filePath The file path to process folders for
   * @returns Promise that resolves with an array of folder/vault node IDs created/found
   */
  private async ensureVaultAndFolderNodes(filePath: string): Promise<string[]> {
    console.log(`[STUB] Would ensure vault and folder nodes for: ${filePath}`);
    return Promise.resolve(['vault-id', 'folder-id']); // Stub IDs
  }

  /**
   * Creates a file node and links it to its parent folder.
   * 
   * @param file The TFile object representing the file
   * @returns Promise that resolves with the file node ID
   */
  private async createFileNode(file: TFile): Promise<string> {
    console.log(`[STUB] Would create file node for: ${file.path}`);
    return Promise.resolve(`file-${file.path}`); // Stub ID
  }

  /**
   * Generates a unique node ID based on file path and position.
   * 
   * @param filePath The file path
   * @param position The position in the file (optional)
   * @returns A unique node ID string
   */
  private generateNodeId(filePath: string, position?: any): string {
    // Stub implementation
    if (position) {
      return `${filePath}-${position.start.line}-${position.start.col}`;
    }
    return filePath;
  }

  /**
   * Generates a file node ID.
   * 
   * @param filePath The file path
   * @returns The file node ID
   */
  private generateFileId(filePath: string): string {
    return `file-${filePath}`;
  }

  /**
   * Creates a Cypher statement to create a heading node.
   * 
   * @param nodeId The node ID
   * @param heading The heading metadata
   * @param filePath The file path
   * @returns A Cypher statement string
   */
  private createHeadingNodeStatement(nodeId: string, heading: any, filePath: string): string {
    return `CREATE (:Block {id: '${this.escapeCypher(nodeId)}', type: 'heading', path: '${this.escapeCypher(filePath)}'})`;
  }

  /**
   * Creates a Cypher statement to create a list item node.
   * 
   * @param nodeId The node ID
   * @param listItem The list item metadata
   * @param itemType The determined item type
   * @param filePath The file path
   * @returns A Cypher statement string
   */
  private createListItemNodeStatement(nodeId: string, listItem: any, itemType: string, filePath: string): string {
    return `CREATE (:Block {id: '${this.escapeCypher(nodeId)}', type: '${itemType}', path: '${this.escapeCypher(filePath)}'})`;
  }

  /**
   * Creates a Cypher statement to create a generic section node.
   * 
   * @param nodeId The node ID
   * @param section The section metadata
   * @param content The section content
   * @param filePath The file path
   * @returns A Cypher statement string
   */
  private createSectionNodeStatement(nodeId: string, section: any, content: string, filePath: string): string {
    return `CREATE (:Block {id: '${this.escapeCypher(nodeId)}', type: '${section.type}', path: '${this.escapeCypher(filePath)}'})`;
  }

  /**
   * Creates a Cypher statement to create a relationship between nodes.
   * 
   * @param fromId The source node ID
   * @param toId The target node ID
   * @param type The relationship type
   * @param explicit Whether the relationship is explicit
   * @returns A Cypher statement string
   */
  private createRelationshipStatement(fromId: string, toId: string, type: string, explicit = false): string {
    return `MATCH (a:Block {id: '${this.escapeCypher(fromId)}'}), (b:Block {id: '${this.escapeCypher(toId)}'}) 
          CREATE (a)-[:Link {type: '${this.escapeCypher(type)}', explicit: ${explicit}}]->(b)`;
  }

  /**
   * Finds the container node for a given position in the file.
   * 
   * @param position The position to find a container for
   * @param headings Array of headings to check
   * @param filePath The file path
   * @returns The ID of the container node
   */
  private findContainerForPosition(position: any, headings: any[] | undefined, filePath: string): string {
    return this.generateFileId(filePath); // Default to file as container
  }

  /**
   * Finds the node that contains a given position.
   * 
   * @param position The position to find
   * @param metadata The file metadata
   * @returns The ID of the node containing the position, or undefined
   */
  private findNodeContainingPosition(position: any, metadata: any): string | undefined {
    return this.generateFileId(metadata.filePath); // Stub implementation
  }

  /**
   * Resolves a link to a node ID.
   * 
   * @param link The link text (e.g., "#heading" or "file#^blockid")
   * @param metadata The file metadata
   * @returns The ID of the target node, or undefined if not found
   */
  private resolveLink(link: string, metadata: any): string | undefined {
    return `link-target-${link}`; // Stub implementation
  }

  /**
   * Determines the type of a list item based on its metadata and block content.
   * 
   * @param listItem The list item metadata
   * @param blocks The block cache data
   * @returns The determined item type
   */
  private determineListItemType(listItem: any, blocks: any[]): string {
    if (listItem.task) {
      switch (listItem.task) {
        case ' ': return 'task.open';
        case 'x': return 'task.completed';
        case '/': return 'task.in_progress';
        case '!': return 'task.blocked';
        case '-': return 'task.cancelled';
        // Add other special task types...
        default: return 'task';
      }
    }
    return 'bullet';
  }

  /**
   * Finds the content of a block in the block cache.
   * 
   * @param section The section metadata
   * @param blocks The block cache data
   * @returns The content of the block
   */
  private findBlockContent(section: any, blocks: any[]): string {
    return '[Stub content]';
  }

  /**
   * Checks if a section type should be processed.
   * 
   * @param sectionType The type of section
   * @returns True if the section should be processed
   */
  private isProcessableSection(sectionType: string): boolean {
    const processableTypes = ['paragraph', 'code', 'blockquote', 'list'];
    return processableTypes.includes(sectionType);
  }

  /**
   * Executes a transaction with multiple Cypher statements.
   * 
   * @param statements Array of Cypher statements
   * @returns Promise that resolves when the transaction is complete
   */
  private async executeTransaction(statements: string[]): Promise<void> {
    console.log(`[STUB] Would execute ${statements.length} statements`);
    return Promise.resolve();
  }

}


