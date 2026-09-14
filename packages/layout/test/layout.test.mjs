import test from 'node:test';
import assert from 'node:assert/strict';
import { NetworkLayoutEngine } from '../src/index.mjs';

test('NetworkLayoutEngine computes deterministic DAG layout without long snake', () => {
  const blocks = [
    { id: 'b1', title: 'Input Gateway' },
    { id: 'b2', title: 'Auth Service' },
    { id: 'b3', title: 'Billing Service' },
    { id: 'b4', title: 'Notification Service' },
    { id: 'b5', title: 'Analytics' },
    { id: 'b6', title: 'Database' },
  ];

  const chains = [
    { id: 'chain-core', memberIds: ['b1', 'b2', 'b6'] },
    { id: 'chain-business', memberIds: ['b3', 'b4', 'b5'] },
  ];

  const links = [
    { id: 'l1', from: 'b1', to: 'b2', kind: 'flows_to' },
    { id: 'l2', from: 'b2', to: 'b3', kind: 'calls' },
    { id: 'l3', from: 'b2', to: 'b4', kind: 'calls' },
    { id: 'l4', from: 'b3', to: 'b6', kind: 'depends_on' },
    { id: 'l5', from: 'b4', to: 'b5', kind: 'flows_to' },
  ];

  const layout = NetworkLayoutEngine.computeLayout({
    blocks,
    chains,
    links,
    options: { maxColumns: 3 },
  });

  assert.equal(layout.nodes.length, 6);
  assert.equal(layout.edges.length, 5);
  assert.ok(layout.bounds.width > 0);
  assert.ok(layout.bounds.height > 0);

  // Nodes in earlier ranks should have smaller Y than subsequent ranks
  const nodeB1 = layout.nodes.find((n) => n.id === 'b1');
  const nodeB6 = layout.nodes.find((n) => n.id === 'b6');
  assert.ok(nodeB1.y < nodeB6.y);

  // Re-running layout must be 100% deterministic (same positions)
  const layout2 = NetworkLayoutEngine.computeLayout({
    blocks,
    chains,
    links,
    options: { maxColumns: 3 },
  });
  assert.deepEqual(layout.nodes, layout2.nodes);
});
