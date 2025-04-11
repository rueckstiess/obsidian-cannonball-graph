import { remark } from 'remark';
import remarkFrontmatter from 'remark-frontmatter';
// import remarkGfm from 'remark-gfm';
import { inspect } from 'unist-util-inspect';
import remarkCustomTasks from 'remark-custom-tasks'
import { visit, EXIT, CONTINUE } from 'unist-util-visit';
import { Parent, Root, Node, Heading, ListItem, Code, Text } from 'mdast';
import { visitParents } from 'unist-util-visit-parents';


/**
 * Parse markdown content into an AST using remark
 * @param markdownContent The markdown content to parse
 * @returns The parsed AST as a Root node
 */
export async function parseMarkdownToAST(markdownContent: string): Promise<Root> {
  const processor = remark()
    .use(remarkCustomTasks)
    .use(remarkFrontmatter);

  const ast = processor.parse(markdownContent);
  await processor.run(ast);

  return ast;
}


/**
 * Simple utility to log the AST to the console for debugging
 * @param markdownContent The markdown content to parse and log
 */
export async function logMarkdownAST(markdownContent: string): Promise<void> {
  const ast = await parseMarkdownToAST(markdownContent);
  console.log('Markdown AST:');
  console.log(inspect(ast));
}

/**
 * Convert an AST back to markdown text
 * @param ast The AST to convert
 * @returns The markdown text
 */
export async function astToMarkdown(ast: Root): Promise<string> {
  const markdown = await remark()
    .use(remarkCustomTasks)
    .use(remarkFrontmatter)
    // .use(remarkGfm)
    .stringify(ast, {
      listItemIndent: 'tab',     // Use tab indentation for list items
      bullet: '-',               // Use - for bullet points
      emphasis: '_',             // Use _ for emphasis
      strong: '*',               // Use ** for strong
      fences: true,              // Use ``` for code blocks
      incrementListMarker: true, // Increment ordered list marker
      setext: false              // Use atx-style headings (# headings)
    })

  return markdown;
}



/**
 * Parse markdown to AST and then back to markdown
 * This is useful for testing or normalizing markdown
 * @param markdownContent The markdown content to process
 * @returns The processed markdown content
 */
export async function roundTripMarkdown(markdownContent: string): Promise<string> {
  const ast = await parseMarkdownToAST(markdownContent);
  return astToMarkdown(ast);
}

/**
 * Finds the most specific mdast node at the current cursor position
 * 
 * @param ast - The markdown AST (Root node)
 * @param cursorPosition - The current cursor position with line and column
 * @returns The most specific node at the cursor position, or undefined if none found
 */
export function findNodeAtCursor(ast: Root, cursorPosition: { line: number, ch: number }): Node | undefined {
  // Convert Obsidian's ch (character) to column used in mdast
  // mdast uses 1-based line numbers and column numbers
  const cursor = {
    line: cursorPosition.line + 1,
    column: cursorPosition.ch + 1
  };

  let matchingNode: Node | undefined = undefined;
  let smallestArea = Infinity;

  // Recursive function to visit all nodes
  function visitNode(node: Node): void {
    if (isNodeAtPosition(node, cursor)) {
      // Calculate the "area" of the node (smaller means more specific)
      const area = calculateNodeArea(node);

      if (area < smallestArea) {
        smallestArea = area;
        matchingNode = node;
      }
    }

    // Continue traversing the tree
    if ('children' in node && Array.isArray((node as Parent).children)) {
      for (const child of (node as Parent).children) {
        visitNode(child);
      }
    }
  }

  // Start traversing from the root
  visitNode(ast);

  return matchingNode;
}

/**
 * Checks if a cursor position is within a node's position
 */
function isNodeAtPosition(node: Node, cursor: { line: number, column: number }): boolean {
  if (!node.position) return false;

  const { start, end } = node.position;

  // Check if cursor is within the node's position boundaries
  if (cursor.line < start.line || cursor.line > end.line) {
    return false;
  }

  // If cursor is at start line, column must be >= start column
  if (cursor.line === start.line && cursor.column < start.column) {
    return false;
  }

  // If cursor is at end line, column must be <= end column
  if (cursor.line === end.line && cursor.column > end.column) {
    return false;
  }

  return true;
}

/**
 * Calculates the "area" of a node based on its position
 * Smaller area = more specific node
 */
function calculateNodeArea(node: Node): number {
  if (!node.position) return Infinity;

  const { start, end } = node.position;

  // If the node spans multiple lines
  if (end.line > start.line) {
    return (end.line - start.line) * 1000 + (end.column - start.column);
  }

  // If the node is on a single line
  return end.column - start.column;
}

// Function to return the lines from the markdownContent covering this node
export function contentFromNode(node: Node, markdownContent: string): string {
  if (!node.position) {
    return '';
  }
  const start = node.position.start;
  const end = node.position.end;

  // get all lines from start to end
  let lines = markdownContent.split('\n');
  lines = lines.slice(start.line - 1, end.line);

  return lines.join('\n');
}

export function removeCursorMarker(markdownContent: string): string {
  return markdownContent.replace(/<CURSOR>/g, '');
}


export function addCursorMarker(cursorPosition: { line: number, ch: number }, markdownContent: string): string {
  const lines = markdownContent.split('\n');
  const line = Math.min(cursorPosition.line, lines.length - 1);
  const ch = Math.min(cursorPosition.ch, lines[line].length);

  const before = lines[line].substring(0, ch);
  const after = lines[line].substring(ch);
  lines[line] = before + "<CURSOR>" + after;

  return lines.join('\n');
}

// Function to build the context from the current node
export function buildContextFromNode(tree: Root, nodeAtCursor: Node | undefined, markdownContent: string): string {
  if (!nodeAtCursor || !nodeAtCursor.position) {
    return '';
  }

  // only visit the target node
  const test = (node: Node) => node === nodeAtCursor;

  // get ancestors of node
  let cursorAncestors: Node[] = [];
  visitParents(tree, test, (node, ancestors) => {
    cursorAncestors = ancestors;
    return EXIT; // Stop visiting after finding the target node
  }, true);

  if (cursorAncestors.length === 0) {
    // we are at the root node, return entire document
    return markdownContent;
  }

  if (cursorAncestors.length === 1) {
    // we are at a top level node, return content based on start/stop of node
    return contentFromNode(nodeAtCursor, markdownContent);
  }

  return contentFromNode(cursorAncestors[1], markdownContent);
}



// Function to find top-level ancestor of a node
export function findTopLevelAncestor(tree: Root, targetNode: Node | undefined): Node | null {
  let topLevelNode: Node | null = null;

  if (!targetNode) {
    return null; // No target node provided
  }

  // only visit the target node
  const test = (node: Node) => node === targetNode;

  visitParents(tree, test, (node, ancestors) => {
    if (ancestors.length === 1) {
      // the targetNode is top-level itself
      topLevelNode = node;
    } else if (ancestors.length > 1) {
      topLevelNode = ancestors[1];
    }
    return EXIT; // Stop visiting after finding the target node
  }, true);
  return topLevelNode;
}

// Define container node types
type ContainerType = 'root' | 'heading' | 'listItem' | 'blockquote';

// Extended node with container information
export interface ExtendedNode extends Node {
  containerType?: ContainerType;
  headingLevel?: number; // For heading nodes
  containedNodes?: ExtendedNode[]; // Optional direct storage of contained nodes
}

// Callback for containment relationships
export type ContainmentCallback = (container: ExtendedNode, contained: ExtendedNode) => void;

const ignoreTypes = ['root', 'list', 'text', 'strong', 'emphasis']

/**
 * Builds hierarchical relationships between nodes in a markdown AST
 * based on document structure and containment rules.
 * Uses a callback for memory efficiency with large documents.
 * 
 * This models Obsidian's folding behavior:
 * - Headings contain all content until the next heading of same or higher level
 * - List items contain their nested items
 * - Blockquotes contain their content
 */
export function processHierarchicalRelationships(ast: Root, callback: ContainmentCallback): void {
  const containerStack: ExtendedNode[] = [];

  // Initialize with root
  const rootNode = ast as ExtendedNode;
  rootNode.containerType = 'root';
  containerStack.push(rootNode);

  // Process the AST using depth-first tarversal
  visit(ast, (node: Node, index: number, parent: Parent | null) => {
    const currentNode = node as ExtendedNode;

    // Skip root and certain other nodes
    if (ignoreTypes.includes(node.type)) {
      return CONTINUE
    }

    // Handle thematic break - reset stack to just root
    if (node.type === 'thematicBreak') {
      // Pop all containers except root
      while (containerStack.length > 1) {
        containerStack.pop();
      }
      // thematic breaks don't belong anywhere
      return CONTINUE;
    }

    // Handle container nodes (root, heading, listItem, blockquote)
    if (isContainerNode(node)) {
      currentNode.containerType = getContainerType(node);

      // Special handling for heading containers
      if (node.type === 'heading') {
        const headingNode = node as Heading & ExtendedNode;
        headingNode.headingLevel = headingNode.depth;

        // Pop containers until finding appropriate parent for this heading
        while (containerStack.length > 1) {
          const topContainer = containerStack[containerStack.length - 1];

          // If top container is a heading, check level
          if (topContainer.containerType === 'heading') {
            const topHeadingLevel = (topContainer as ExtendedNode).headingLevel || 0;

            // Only keep headings of higher level (lower number)
            if (topHeadingLevel < headingNode.headingLevel) {
              break;
            }
          } else if (topContainer.containerType === 'root') {
            // Root can contain any heading
            break;
          }

          // Pop inappropriate container
          containerStack.pop();
        }
      }
      // Special handling for list items
      else if (node.type === 'listItem') {
        const topContainer = containerStack[containerStack.length - 1];

        // If top of stack is a list item, check if it's a direct parent
        if (topContainer.containerType === 'listItem') {
          const isDirectParent = isDirectParentListItem(
            topContainer as ListItem & ExtendedNode,
            currentNode as ListItem & ExtendedNode,
            parent
          );

          if (!isDirectParent) {
            // Pop list items until finding a valid container
            while (
              containerStack.length > 1
              // containerStack[containerStack.length - 1].containerType === 'listItem'
            ) {
              containerStack.pop();
            }
          }
        }
      }
      // For blockquote, just process normally - it will contain its children

      // Add relationship with current top of stack
      const container = containerStack[containerStack.length - 1];
      callback(container, currentNode);

      // Push container node onto stack
      containerStack.push(currentNode);
    } else {
      // For non-container nodes, simply add relationship with current top of stack
      const container = containerStack[containerStack.length - 1];
      callback(container, currentNode);
    }
  });
}

/**
 * Builds a hierarchical containment tree from the AST
 * Returns the root node with all contained nodes accessible through the tree
 */
export function buildContainmentTree(ast: Root): ExtendedNode {
  const rootNode = ast as ExtendedNode;
  const nodeMap = new Map<Node, ExtendedNode[]>();

  // Process relationships and store contained nodes
  processHierarchicalRelationships(ast, (container, contained) => {
    if (!nodeMap.has(container)) {
      nodeMap.set(container, []);
    }
    nodeMap.get(container)?.push(contained);
  });

  // Attach contained nodes to their containers
  for (const [container, containedNodes] of nodeMap.entries()) {
    (container as ExtendedNode).containedNodes = containedNodes;
  }

  return rootNode;
}

/**
 * Get all nodes contained by a specific node in the hierarchy
 * @param tree The containment tree (from buildContainmentTree)
 * @param targetNode The node to get contained nodes for
 * @returns Array of nodes contained by the target node
 */
export function getContainedNodes(tree: ExtendedNode, targetNode: Node): ExtendedNode[] {
  // If the node has containedNodes directly, return them
  const extendedTarget = targetNode as ExtendedNode;
  if (extendedTarget.containedNodes) {
    return extendedTarget.containedNodes;
  }

  // Otherwise, search the tree
  function findContainedNodesForTarget(node: ExtendedNode): ExtendedNode[] | null {
    if (node === targetNode) {
      return node.containedNodes || [];
    }

    if (node.containedNodes) {
      for (const contained of node.containedNodes) {
        const result = findContainedNodesForTarget(contained);
        if (result) return result;
      }
    }

    return null;
  }

  return findContainedNodesForTarget(tree) || [];
}

/**
 * Determines if a node is a container type
 */
function isContainerNode(node: Node): boolean {
  return node.type === 'root' ||
    node.type === 'heading' ||
    node.type === 'listItem' ||
    node.type === 'blockquote';
}

/**
 * Visualizes the containment tree using a format similar to unist-util-inspect
 * Shows the hierarchical containment structure rather than the flat AST
 * 
 * @param tree The containment tree to visualize
 * @returns A string representation of the containment hierarchy
 */
export function inspectContainmentTree(tree: ExtendedNode): string {
  let output = '';
  const visitedInThisPath = new Set<Node>();  // Track nodes in current path
  const allVisitedNodes = new Set<Node>();    // Track all nodes to prevent duplicates

  function formatNode(node: ExtendedNode): string {
    let type = node.type;

    // Add details based on node type
    if (node.type === 'heading') {
      const headingNode = node as Heading & ExtendedNode;
      type = `heading[${headingNode.depth}]`;
    } else if (node.type === 'text') {
      type = `text "${(node as Text).value}"`;
    } else if (node.type === 'code') {
      const lang = (node as Code).lang || '';
      type = `code[${lang}]`;
    } else if (node.type === 'listItem') {
      const checked = (node as ListItem).checked;
      type = checked === null ? 'listItem' : `listItem[${checked ? '✓' : '✗'}]`;
    }

    if (node.position) {
      const { start, end } = node.position;
      return `${type} (${start.line}:${start.column}-${end.line}:${end.column})`;
    }

    return type;
  }

  function visit(node: ExtendedNode, level = 0, isLast = true, prefix = ''): void {
    // Check for circular references in current path
    if (visitedInThisPath.has(node)) {
      output += prefix + (isLast ? '└─ ' : '├─ ') + formatNode(node) + ' [circular ref]\n';
      return;
    }

    // Check if we've already seen this node in another branch
    if (allVisitedNodes.has(node)) {
      return; // Skip duplicates entirely
    }

    // Mark node as visited
    visitedInThisPath.add(node);
    allVisitedNodes.add(node);

    const nodePrefix = level === 0 ? '' : isLast ? '└─ ' : '├─ ';
    const childPrefix = level === 0 ? '' : isLast ? '   ' : '│  ';

    // Print current node
    output += prefix + nodePrefix + formatNode(node) + '\n';

    // Print contained nodes
    if (node.containedNodes && node.containedNodes.length > 0) {
      // Group nodes by type for better visualization
      const directContainers = node.containedNodes.filter(n => isContainerNode(n));
      const directNonContainers = node.containedNodes.filter(n => !isContainerNode(n));

      // Group non-container nodes when there are many
      if (directNonContainers.length > 5) {
        // Group by type for summary
        const typeCount = new Map<string, number>();
        directNonContainers.forEach(n => {
          const count = typeCount.get(n.type) || 0;
          typeCount.set(n.type, count + 1);
        });

        const typeSummary = Array.from(typeCount.entries())
          .map(([type, count]) => `${type}(${count})`)
          .join(', ');

        const nonContainerPrefix = prefix + childPrefix;
        const summaryNodePrefix = directContainers.length === 0 ? '└─ ' : '├─ ';
        output += nonContainerPrefix + summaryNodePrefix +
          `[${directNonContainers.length} non-container nodes: ${typeSummary}]\n`;

        // Process container nodes
        directContainers.forEach((child, i) => {
          visit(
            child,
            level + 1,
            i === directContainers.length - 1,
            prefix + childPrefix
          );
        });
      } else {
        // Process all nodes normally
        const allNodes = [...node.containedNodes]; // Create a copy to avoid modifying the original
        allNodes.forEach((child, i) => {
          visit(
            child,
            level + 1,
            i === allNodes.length - 1,
            prefix + childPrefix
          );
        });
      }
    }

    // Remove node from current path when done with this branch
    visitedInThisPath.delete(node);
  }

  visit(tree);
  return output;
}

/**
 * Gets the container type for a node
 */
function getContainerType(node: Node): ContainerType {
  if (node.type === 'root') return 'root';
  if (node.type === 'heading') return 'heading';
  if (node.type === 'listItem') return 'listItem';
  if (node.type === 'blockquote') return 'blockquote';
  throw new Error(`Unknown container type: ${node.type}`);
}

/**
 * Checks if a list item is a direct parent of another list item
 * (skipping the intermediate list node)
 */
function isDirectParentListItem(
  potentialParent: ListItem & ExtendedNode,
  child: ListItem & ExtendedNode,
  childParent: Parent | null
): boolean {
  // Check if the child's parent is a list that is a direct child of the potential parent
  if (potentialParent.children && childParent && childParent.type === 'list') {
    for (const item of potentialParent.children) {
      if (item.type === 'list' && item === childParent) {
        return true;
      }
    }
  }

  return false;
}
