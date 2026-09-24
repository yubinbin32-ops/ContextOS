import test from 'node:test';
import assert from 'node:assert/strict';
import { NetworkLayoutEngine } from '../src/index.mjs';

test('NetworkLayoutEngine computes deterministic square shelf layout', () => {
  const blocks = Array.from({ length: 59 }, (_, index) => ({
    id: `b${String(index + 1).padStart(2, '0')}`,
    title: `Block ${index + 1}`,
  }));

  const lengths = [9, 8, 7, 6, 5, 4, 3, 3, 3, 2, 2, 2, 1];
  let cursor = 0;
  const chains = lengths.map((length, index) => {
    const memberIds = blocks.slice(cursor, cursor + length).map((block) => block.id);
    cursor += length;
    return { id: `chain-${index + 1}`, memberIds };
  });

  const links = blocks.slice(1).map((block, index) => ({
    id: `l${index + 1}`,
    from: blocks[index].id,
    to: block.id,
    kind: 'flows_to',
  }));

  const layout = NetworkLayoutEngine.computeLayout({ blocks, chains, links });

  assert.equal(layout.nodes.length, blocks.length);
  assert.equal(layout.edges.length, links.length);
  assert.deepEqual(
    layout.nodes.map((node) => node.id).sort(),
    blocks.map((block) => block.id).sort(),
  );

  const occupied = layout.nodes.map((node) => `${node.x},${node.y}`);
  assert.equal(new Set(occupied).size, blocks.length, 'blocks must not overlap in the shelf grid');
  assert.ok(new Set(layout.nodes.map((node) => node.x)).size > 1, 'layout must use multiple columns');
  assert.ok(new Set(layout.nodes.map((node) => node.y)).size > 1, 'layout must use multiple rows');

  const aspect = layout.bounds.width / layout.bounds.height;
  assert.ok(aspect > 0.72 && aspect < 1.4, `layout bounds should be near-square, received ${aspect}`);
  assert.ok(layout.bounds.height < layout.bounds.width * 1.6, 'layout must not regress to a vertical stack');

  const layout2 = NetworkLayoutEngine.computeLayout({ blocks, chains, links });
  assert.deepEqual(layout.nodes, layout2.nodes);
});

test('NetworkLayoutEngine keeps a shared-chain suffix near its owned anchors', () => {
  const anchors = Array.from({ length: 7 }, (_, index) => `anchor-${index}`);
  const filler = Array.from({ length: 40 }, (_, index) => `f${String(index).padStart(2, '0')}`);
  const detached = 'detached';
  const blocks = [...anchors, detached, ...filler].map((id) => ({ id, title: id }));
  const chains = [
    { id: 'primary', memberIds: anchors },
    { id: 'shared-suffix', memberIds: [anchors[1], anchors[2], detached] },
  ];
  const links = anchors.slice(1).map((id, index) => ({
    id: `anchor-link-${index}`,
    from: anchors[index],
    to: id,
  }));

  const layout = NetworkLayoutEngine.computeLayout({ blocks, chains, links });
  const detachedNode = layout.nodes.find((node) => node.id === detached);
  const anchorNode = layout.nodes.find((node) => node.id === anchors[2]);

  assert.ok(detachedNode);
  assert.ok(anchorNode);
  const columnDistance = Math.abs(detachedNode.x - anchorNode.x) / 300;
  const rowDistance = Math.abs(detachedNode.y - anchorNode.y) / 200;
  assert.ok(columnDistance + rowDistance <= 2, 'shared-chain suffix must stay beside its anchors');
});
