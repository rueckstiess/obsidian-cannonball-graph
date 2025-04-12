import { KuzuClient } from './kuzu-client';
import { visit } from 'unist-util-visit';
import { Node, Parent, Root, Text } from 'mdast';
import { processHierarchicalRelationships, ExtendedNode, ContainmentCallback } from './markdown';

/**
 * Service class for converting markdown AST to graph database nodes and relationships.
 * Handles the complexity of mapping AST nodes to a graph structure.
 */
export class AstGraphService {
  private kuzuClient: KuzuClient;
  private nodeIdCounter = 0;
  private nodeIDs = new Map<Node, string>();
  private isReady = false;

  /**
   * Creates a new AstGraphService
   * 
   * @param kuzuClient The KuzuDB client instance to use
   */
  constructor(kuzuClient: KuzuClient) {
    this.kuzuClient = kuzuClient;
  }

  /**
   * Initialize the graph schema for AST nodes.
   * Creates necessary node and relationship tables.
   */
  public async initSchema(): Promise<void> {
    await this.kuzuClient.transaction([
      // Drop existing tables if they exist
      'DROP TABLE IF EXISTS LINK',
      'DROP TABLE IF EXISTS Element',

      // Node tables for different AST node types
      `CREATE NODE TABLE Element (
        id String,            // unique identifier for the node
        type STRING,          // e.g. "Task", "Question", "Decision", "Paragraph", etc.
        text STRING,          // raw content
        state STRING,         // e.g. "open", "done", "blocked", etc.
        tags STRING[],        // from inline or file metadata
        ref STRING,           // like ^alt1 (used for linking)
        sourceFile STRING,    // which markdown file this came from
        line INT32,           // line number in file
        PRIMARY KEY(id)
      )`,

      // Edge tables for relationships
      `CREATE REL TABLE LINK(
        FROM Element TO Element,
        type STRING,  // e.g. "CONTAINS", "DEPENDS_ON", "CHOSEN", etc.
        rank INT32    // optional: ordering among children(if needed)
      )`
    ]);

    this.isReady = true;
  }

  /**
   * Reset the internal state of the service.
   * Call this before processing a new document to avoid ID conflicts.
   */
  public reset(): void {
    this.nodeIdCounter = 0;
    this.nodeIDs.clear();
  }

  /**
   * Process a markdown AST and store it in the graph database.
   * 
   * @param ast The markdown AST to process
   * @param sourcePath Optional source path of the document
   * @returns The number of nodes created
   */
  public async processAst(ast: Root, sourcePath?: string): Promise<number> {
    if (!this.isReady) {
      await this.initSchema();
    }

    this.reset();

    // First pass: create all nodes
    await this.createNodesFromAst(ast, sourcePath);

    // Second pass: create relationships
    await this.createRelationshipsFromAst(ast);

    return this.nodeIDs.size;
  }

  private createNodeProperties(obj: Record<string, any>): string {
    const props = Object.entries(obj)
      .map(([key, value]) => {
        if (typeof value === 'string') {
          return `${key}: '${value}'`;
        }
        return `${key}: ${value}`;
      })
      .join(', ');

    return `{ ${props} }`;
  }

  /**
   * Creates graph nodes for each AST node.
   */
  private async createNodesFromAst(ast: Root, sourcePath?: string): Promise<void> {
    const cypher: string[] = [];

    // Visit all nodes and create corresponding graph nodes
    visit(ast, (node: Node, index: number, parent?: Parent) => {
      const nodeId = `${node.type}-${this.getNodeId()}`;
      this.nodeIDs.set(node, nodeId);

      // create properties for the node
      const properties: Record<string, any> = {
        id: nodeId,
        type: node.type,
        // text: this.getTextContent(node),
        // state: node.data?.state || null,
        // tags: node.data?.tags || [],
        // ref: node.data?.ref || null,
        sourceFile: sourcePath || null,
        line: node.position?.start.line || null
      };

      // Create a base node for every AST node
      cypher.push(`CREATE (:Element ${this.createNodeProperties(properties)})`);
    });

    // Execute the transaction to create all nodes
    if (cypher.length > 0) {
      console.log('Creating nodes:', cypher);
      const result = await this.kuzuClient.transaction(cypher);
      console.log('Node creation result:', result);
    }
  }

  /**
   * Creates relationships between AST nodes in the graph.
   */
  private async createRelationshipsFromAst(ast: Root): Promise<void> {
    const cypher: string[] = [];
    const processedPairs = new Set<string>();

    // Create "renders" relationships for all nodes based on AST
    visit(ast, (node: Node, index: number, parent?: Parent) => {

      const nodeId = this.nodeIDs.get(node);
      const parentId = parent ? this.nodeIDs.get(parent) : null;

      if (!nodeId) {
        return;
      }

      if (index === undefined) {
        index = 0;
      }

      cypher.push(`
        MATCH (parent:Element {id: '${parentId}'}), 
              (child:Element {id: '${nodeId}'})
        CREATE (parent)-[:LINK {type: "renders", rank: ${index}}]->(child)
       `);
    });



    // Use the containment relationships to build the graph structure
    const callback: ContainmentCallback = (container: ExtendedNode, contained: ExtendedNode) => {
      const containerId = this.nodeIDs.get(container);
      const containedId = this.nodeIDs.get(contained);

      if (!containerId || !containedId) {
        return;
      }

      // Create a unique identifier for this relationship to avoid duplicates
      const relationshipKey = `${containerId}-${containedId}`;
      if (!processedPairs.has(relationshipKey)) {
        processedPairs.add(relationshipKey);

        cypher.push(`
          MATCH (container:Element {id: '${containerId}'}), 
                (contained:Element {id: '${containedId}'})
          CREATE (container)-[:LINK {type: "contains"}]->(contained)
        `);
      }
    };

    // Process hierarchical relationships
    processHierarchicalRelationships(ast, callback);

    // Execute the transaction to create all relationships
    if (cypher.length > 0) {
      await this.kuzuClient.transaction(cypher);
    }
  }

  /**
   * Gets a unique node ID for the current processing session.
   */
  private getNodeId(): number {
    return this.nodeIdCounter++;
  }

  /**
   * Extracts text content from a node.
   */
  private getTextContent(node: Node): string {
    let text = '';

    visit(node, 'text', (textNode: Node) => {
      text += (textNode as Text).value || '';
    });

    return text;
  }

  /**
   * Escapes a string for safe use in Cypher queries.
   */
  private escapeCypherString(value: string): string {
    // Replace any single quotes with escaped single quotes and wrap in single quotes
    return `'${value.replace(/'/g, "\\'")}'`;
  }

  /**
   * Runs a query to find AST nodes matching specific criteria.
   * 
   * @param type Node type to query for
   * @param properties Additional properties to match
   * @returns The query results
   */
  public async queryElements(type: string, properties: Record<string, any> = {}): Promise<any[]> {
    let whereClause = '';

    if (Object.keys(properties).length > 0) {
      const conditions = Object.entries(properties)
        .map(([key, value]) => {
          if (typeof value === 'string') {
            return `n.${key} = '${value.replace(/'/g, "\\'")}'`;
          }
          return `n.${key} = ${value}`;
        })
        .join(' AND ');

      whereClause = `WHERE ${conditions}`;
    }

    const query = `
            MATCH (n:${type}) 
            ${whereClause}
            RETURN n 
            LIMIT 100
        `;

    return await this.kuzuClient.query(query);
  }

  /**
   * Runs a query to find relationships between AST nodes.
   * 
   * @param fromType Source node type
   * @param relType Relationship type
   * @param toType Target node type
   * @returns The query results
   */
  public async queryAstRelationships(fromType: string, relType: string, toType: string): Promise<any[]> {
    const query = `
            MATCH (a:${fromType})-[r:${relType}]->(b:${toType})
            RETURN a, r, b
            LIMIT 100
        `;

    return await this.kuzuClient.query(query);
  }
}