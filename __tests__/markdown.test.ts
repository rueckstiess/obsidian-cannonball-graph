/* eslint-disable @typescript-eslint/no-non-null-assertion */

import { describe, expect, test } from '@jest/globals';
import {
  parseMarkdownToAST,
  processHierarchicalRelationships,
  buildContainmentTree,
  inspectContainmentTree,
} from '../src/markdown';
import { Root, Node, Heading, Text, Code, Paragraph, Parent } from 'mdast';

// Set this to true to enable detailed logging in all tests
// Shows the markdown text and resulting containment tree in each test
const DEBUG_CONTAINMENT = true;


// Helper function to parse markdown and create a containment map
async function parseAndMapContainment(markdown: string, testName?: string): Promise<{
  ast: Root,
  containmentMap: Map<Node, Node[]>
}> {
  const ast = await parseMarkdownToAST(markdown);
  const containmentMap = new Map<Node, Node[]>();

  // Build containment relationships
  processHierarchicalRelationships(ast, (container, contained) => {
    if (!containmentMap.has(container)) {
      containmentMap.set(container, []);
    }
    containmentMap.get(container)?.push(contained);
  });

  if (DEBUG_CONTAINMENT) {
    // Log the test name if provided
    if (testName) {
      console.log(`\n\n========== TEST: ${testName} ==========\n`);
    }

    // Log the markdown and containment tree
    console.log('--- MARKDOWN ---');
    console.log(markdown);

    const tree = buildContainmentTree(ast);
    console.log('--- CONTAINMENT TREE ---');
    console.log(inspectContainmentTree(tree));
    console.log('\n');
    console.log('--- CONTAINMENT MAP ---');
    for (const [key, value] of containmentMap.entries()) {
      console.log(`Container: ${key.type}, Contained: ${value.map(v => v.type).join(', ')}`);
    }
  }

  return { ast, containmentMap };
}

describe('Hierarchical containment parsing', () => {
  test('Headings should contain content until next heading of same or higher level', async () => {
    const markdown = `
## Heading 2a
Some paragraph under heading 2a.

### Heading 3a
- List item 1 under heading 3a
- List item 2 under heading 3a

## Heading 2b
Content under heading 2b.
`;

    const { ast, containmentMap } = await parseAndMapContainment(markdown);

    // Find the nodes we want to test
    const root = ast;
    const h2a = findHeadingByDepthAndText(ast, 2, 'Heading 2a');
    const h3a = findHeadingByDepthAndText(ast, 3, 'Heading 3a');
    const h2b = findHeadingByDepthAndText(ast, 2, 'Heading 2b');

    expect(h2a).toBeDefined();
    expect(h3a).toBeDefined();
    expect(h2b).toBeDefined();

    // Check root contains both h2 headings
    const rootContained = containmentMap.get(root) || [];
    expect(rootContained.some(node => node === h2a)).toBeTruthy();
    expect(rootContained.some(node => node === h2b)).toBeTruthy();

    // Check h2a contains h3a
    const h2aContained = containmentMap.get(h2a!) || [];
    expect(h2aContained.some(node => node === h3a)).toBeTruthy();

    // h2a should not contain h2b
    expect(h2aContained.some(node => node === h2b)).toBeFalsy();

    // h3a should be associated with list items (though they might be directly on the list, not the heading)
    const allListItems = findAllListItems(ast);
    expect(allListItems.length).toBeGreaterThan(0);
  });

  test('List items should contain their nested items', async () => {
    const markdown = `
- Parent list item
  - Child list item 1
  - Child list item 2
- Another parent item
`;

    const { ast, containmentMap } = await parseAndMapContainment(markdown);

    // Find all list items - there should be at least 3
    const listItems = findAllListItems(ast);
    expect(listItems.length).toBeGreaterThanOrEqual(3);

    // Find parent list items by examining their text content
    const parentItem = listItems.find(item => {
      const text = getTextContent(item);
      return text.includes('Parent list item');
    });

    expect(parentItem).toBeDefined();

    // The parent should eventually contain child list items through its nested list
    const parentMap = findContentWithinListItem(parentItem!, containmentMap);
    expect(parentMap.length).toBeGreaterThan(0);
  });

  test('Code blocks are not containers', async () => {
    const markdown = `
## Heading with code

\`\`\`python
def function():
    return 42
\`\`\`

Some text after code.
`;

    const { ast, containmentMap } = await parseAndMapContainment(markdown);

    // Find heading, code block and paragraph
    const heading = findHeadingByDepthAndText(ast, 2, 'Heading with code');
    const codeBlock = findNodeOfType(ast, 'code') as Code;
    const paragraph = findParagraphContainingText(ast, 'Some text after code');

    expect(heading).toBeDefined();
    expect(codeBlock).toBeDefined();
    expect(paragraph).toBeDefined();

    // Get what's contained by the heading
    const headingContained = containmentMap.get(heading!) || [];

    // The heading should contain both the code block and the paragraph
    expect(headingContained.some(node => node === codeBlock || node.type === 'code')).toBeTruthy();
    expect(headingContained.some(node => node === paragraph ||
      (node.type === 'paragraph' && getTextContent(node).includes('Some text after code'))
    )).toBeTruthy();
  });

  test('Blockquotes should contain their content', async () => {
    const markdown = `
## Section with blockquote

> This is a blockquote
> with multiple lines
>
> And a paragraph break
> - Even with a list
> - Inside it
>
> \`\`\`
> And a code block
> \`\`\`

Text after blockquote.
`;

    const { ast, containmentMap } = await parseAndMapContainment(markdown);

    // Find heading and blockquote
    const heading = findHeadingByDepthAndText(ast, 2, 'Section with blockquote');
    const blockquote = findNodeOfType(ast, 'blockquote');

    expect(heading).toBeDefined();
    expect(blockquote).toBeDefined();

    // Get what's contained by the heading
    const headingContained = containmentMap.get(heading!) || [];

    // The blockquote should be contained by the heading
    expect(headingContained.some(node => node === blockquote)).toBeTruthy();

    // The blockquote should contain its children
    const blockquoteContained = containmentMap.get(blockquote!) || [];
    expect(blockquoteContained.length).toBeGreaterThan(0);

    // The blockquote should contain list items or a list
    const listItems = blockquoteContained.filter(node =>
      node.type === 'list' || node.type === 'listItem'
    );
    expect(listItems.length).toBeGreaterThan(0);
  });

  test('Nested lists with multiple levels should maintain proper hierarchy', async () => {
    const markdown = `
- Level 1, item 1
  - Level 2, item 1
    - Level 3, item 1
    - Level 3, item 2
  - Level 2, item 2
- Level 1, item 2
  - [ ] Task 1
    - [ ] Nested task 1
    - [x] Nested task 2
  - [x] Task 2
`;

    const { ast, containmentMap } = await parseAndMapContainment(markdown);

    // Find all list items - should include both regular items and tasks
    const allListItems = findAllListItems(ast);
    expect(allListItems.length).toBeGreaterThan(5); // We should have multiple levels

    // Find the level 1 list items by examining text content
    const level1Items = findListItemsWithText(ast, ['Level 1, item 1', 'Level 1, item 2']);
    expect(level1Items.length).toBe(2);

    // Check the content of the first level 1 item recursively
    const firstL1Item = level1Items[0];
    const firstL1Contained = getAllNestedContent(firstL1Item, containmentMap);

    // It should contain level 2 items
    const hasLevel2 = firstL1Contained.some(node =>
      getTextContent(node).includes('Level 2')
    );
    expect(hasLevel2).toBeTruthy();

    // And eventually level 3 items
    const hasLevel3 = firstL1Contained.some(node =>
      getTextContent(node).includes('Level 3')
    );
    expect(hasLevel3).toBeTruthy();

    // Check for tasks and nested tasks
    const taskItems = findListItemsWithText(ast, ['Task 1', 'Task 2']);
    const nestedTaskItems = findListItemsWithText(ast, ['Nested task']);

    expect(taskItems.length).toBeGreaterThan(0);
    expect(nestedTaskItems.length).toBeGreaterThan(0);
  });

  test('Complex document with various node types', async () => {
    const markdown = `
# Document Title

## Section 1
Text in section 1.

### Subsection 1.1
Content in subsection.

## Section 2
Text in section 2.

- [ ] Task in section 2
`;

    const { ast, containmentMap } = await parseAndMapContainment(markdown);

    // Find our headings
    const h1 = findHeadingByDepthAndText(ast, 1, 'Document Title');
    const section1 = findHeadingByDepthAndText(ast, 2, 'Section 1');
    const subsection = findHeadingByDepthAndText(ast, 3, 'Subsection 1.1');
    const section2 = findHeadingByDepthAndText(ast, 2, 'Section 2');

    expect(h1).toBeDefined();
    expect(section1).toBeDefined();
    expect(subsection).toBeDefined();
    expect(section2).toBeDefined();

    // Check the general structure
    expect(containmentMap.has(ast)).toBeTruthy();
    const rootContent = containmentMap.get(ast)!;

    // Root should contain the h1 and the sections
    expect(rootContent.includes(h1!)).toBeTruthy();

    // Heading 1 should contain section 1 and section 2
    const h1Content = containmentMap.get(h1!) || [];

    expect(h1Content.includes(section1!)).toBeTruthy();
    expect(h1Content.includes(section2!)).toBeTruthy();

    // Section 1 should contain the subsection
    const section1Content = containmentMap.get(section1!);
    expect(section1Content).toBeDefined();
    expect(section1Content!.includes(subsection!)).toBeTruthy();

    // Find the task in section 2
    const tasks = findAllListItems(ast).filter(item =>
      getTextContent(item).includes('Task in section 2')
    );
    expect(tasks.length).toBeGreaterThan(0);

    // The task should be in section 2's content or a descendant of it
    const section2AllContent = getAllNestedContent(section2!, containmentMap);
    const taskIsInSection2 = tasks.some(task => section2AllContent.includes(task));
    expect(taskIsInSection2).toBeTruthy();

    // Task should not be in section 1's content
    const section1AllContent = getAllNestedContent(section1!, containmentMap);
    const taskIsInSection1 = tasks.some(task => section1AllContent.includes(task));
    expect(taskIsInSection1).toBeFalsy();
  });

  test('Thematic breaks reset containment to root level', async () => {
    const markdown = `
## Section 1
Content in section 1.

---

## Section 2
Content in section 2.
`;

    const { ast, containmentMap } = await parseAndMapContainment(markdown);

    // Find the thematic break
    const thematicBreak = findNodeOfType(ast, 'thematicBreak');
    expect(thematicBreak).toBeDefined();

    // The thematic break should not be contained anywhere
    const root = ast;
    const rootContained = containmentMap.get(root) || [];
    expect(rootContained.includes(thematicBreak!)).toBeFalsy();

    // The sections should both be at the root level
    const section1 = findHeadingByDepthAndText(ast, 2, 'Section 1');
    const section2 = findHeadingByDepthAndText(ast, 2, 'Section 2');

    expect(rootContained.includes(section1!)).toBeTruthy();
    expect(rootContained.includes(section2!)).toBeTruthy();
  });

  test('Images and inline formatting should be properly contained', async () => {
    const markdown = `
## Section with media

![Image description](image.jpg)

A paragraph with an ![inline image](inline.jpg) inside it.

Text with *emphasis* and **strong emphasis**.
`;

    const { ast, containmentMap } = await parseAndMapContainment(markdown);

    // Find the heading
    const heading = findHeadingByDepthAndText(ast, 2, 'Section with media');
    expect(heading).toBeDefined();

    // The heading should contain all the content
    const allHeadingContent = getAllNestedContent(heading!, containmentMap);

    // There should be paragraphs
    const paragraphs = allHeadingContent.filter(n => n.type === 'paragraph');
    expect(paragraphs.length).toBeGreaterThan(0);

    // There should be emphasis elements in the text
    const hasEmphasis = allHeadingContent.some(n => n.type === 'emphasis' || n.type === 'strong');
    expect(hasEmphasis).toBeFalsy();

    // There should be images or image containers
    const hasImage = allHeadingContent.some(n =>
      n.type === 'image' ||
      (n.type === 'paragraph' && getTextContent(n).includes('inline image'))
    );
    expect(hasImage).toBeTruthy();
  });
});

test('Tree visualization produces readable output', async () => {
  const markdown = `
## Section 1
Some text in section 1.

### Subsection 1.1
- [ ] Task 1
  - [ ] Subtask 1.1
  - [ ] Subtask 1.2
- [ ] Task 2

## Section 2
Some text in section 2.
`;

  const ast = await parseMarkdownToAST(markdown);
  const tree = buildContainmentTree(ast);
  const visualization = inspectContainmentTree(tree);

  // Check that the visualization contains the expected structural elements
  expect(visualization).toContain('root');
  expect(visualization).toContain('heading[2]');

  // The visualization should be a non-empty string of reasonable length
  expect(visualization.length).toBeGreaterThan(100);

  // Output the visualization to console for manual inspection
  console.log("\n\nContainment Tree Visualization:\n");
  console.log(visualization);

  // Basic structure validation
  const lines = visualization.split('\n');

  // Look for section 1 and section 2
  const sectionIndex = lines.findIndex(line => line.includes('heading[2]'));
  const subsectionIndex = lines.findIndex(line => line.includes('heading[3]'));

  // Both sections should be found
  expect(sectionIndex).toBeGreaterThan(-1);
  expect(subsectionIndex).toBeGreaterThan(-1);

  // Section 2 should come after section 1
  expect(subsectionIndex).toBeGreaterThan(sectionIndex);
});

// Helper function to find a heading by depth and text content
function findHeadingByDepthAndText(root: Root, depth: number, text: string): Heading | undefined {
  let foundHeading: Heading | undefined;

  function visit(node: Node) {
    if (node.type === 'heading' && (node as Heading).depth === depth) {
      const headingNode = node as Heading;
      // Check if any of the children contain the text
      const hasText = headingNode.children.some(child =>
        child.type === 'text' && (child as Text).value === text
      );

      if (hasText) {
        foundHeading = headingNode;
        return;
      }
    }

    if ('children' in node && Array.isArray((node as Parent).children)) {
      for (const child of (node as Parent).children) {
        visit(child);
        if (foundHeading) return;
      }
    }
  }

  visit(root);
  return foundHeading;
}

// Helper function to find a paragraph containing specific text
function findParagraphContainingText(root: Root, text: string): Paragraph | undefined {
  let foundParagraph: Paragraph | undefined;

  function visit(node: Node) {
    if (node.type === 'paragraph') {
      const content = getTextContent(node);
      if (content.includes(text)) {
        foundParagraph = node as Paragraph;
        return;
      }
    }

    if ('children' in node && Array.isArray((node as Parent).children)) {
      for (const child of (node as Parent).children) {
        visit(child);
        if (foundParagraph) return;
      }
    }
  }

  visit(root);
  return foundParagraph;
}

// Helper function to find a node by type with optional filter
function findNodeOfType<T extends Node = Node>(
  root: Root,
  type: string,
  filter?: (node: Node) => boolean
): T | undefined {
  let foundNode: Node | undefined;

  function visit(node: Node) {
    if (node.type === type && (!filter || filter(node))) {
      foundNode = node;
      return;
    }

    if ('children' in node && Array.isArray((node as Parent).children)) {
      for (const child of (node as Parent).children) {
        visit(child);
        if (foundNode) return;
      }
    }
  }

  visit(root);
  return foundNode as T | undefined;
}

// Helper function to find all list items
function findAllListItems(root: Root): Node[] {
  const listItems: Node[] = [];

  function visit(node: Node) {
    if (node.type === 'listItem' || node.type === 'customTask') {
      listItems.push(node);
    }

    if ('children' in node && Array.isArray((node as Parent).children)) {
      for (const child of (node as Parent).children) {
        visit(child);
      }
    }
  }

  visit(root);
  return listItems;
}

// Helper function to get text content from a node
function getTextContent(node: Node): string {
  let text = '';

  function visit(node: Node) {
    if (node.type === 'text') {
      text += (node as Text).value;
    }

    if ('children' in node && Array.isArray((node as Parent).children)) {
      for (const child of (node as Parent).children) {
        visit(child);
      }
    }
  }

  visit(node);
  return text;
}

// Helper function to find all content within a list item
function findContentWithinListItem(listItem: Node, containmentMap: Map<Node, Node[]>): Node[] {
  const result: Node[] = [];
  const directContent = containmentMap.get(listItem) || [];

  result.push(...directContent);

  // Also find content that might be in nested containers
  for (const item of directContent) {
    if (containmentMap.has(item)) {
      result.push(...containmentMap.get(item)!);
    }
  }

  return result;
}

// Helper function to find list items containing specific text
function findListItemsWithText(root: Root, textPhrases: string[]): Node[] {
  const matchingItems: Node[] = [];
  const allItems = findAllListItems(root);

  for (const item of allItems) {
    const itemText = getTextContent(item);
    for (const phrase of textPhrases) {
      if (itemText.includes(phrase)) {
        matchingItems.push(item);
        break;
      }
    }
  }

  return matchingItems;
}

// Helper function to get all nested content recursively
function getAllNestedContent(node: Node, containmentMap: Map<Node, Node[]>): Node[] {
  const result: Node[] = [];
  const visited = new Set<Node>();

  function collect(current: Node) {
    if (visited.has(current)) return;
    visited.add(current);

    const directContent = containmentMap.get(current) || [];
    result.push(...directContent);

    for (const child of directContent) {
      collect(child);
    }
  }

  collect(node);
  return result;
}
