/**
 * Peer Discovery Integration Test
 * Sprint: Peer Discovery (Task 5)
 *
 * Tests end-to-end peer discovery workflow:
 * - Register peers
 * - Discover by capability
 * - Heartbeat and status changes
 * - Send/receive messages
 * - Broadcast
 * - Deregister
 */

const sqlite3 = require('better-sqlite3');
const path = require('path');
const PeerRegistry = require('../src/peers/peer-registry');
const PeerMessaging = require('../src/peers/peer-messaging');
const { SQLiteStorageAdapter } = require('../src/storage/sqlite-storage-adapter');

// Test configuration
const TEST_DB_PATH = ':memory:'; // In-memory SQLite for testing
const TIMEOUT = 5000;

// Test utilities
let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertEquals(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`Expected ${expected} but got ${actual}: ${message}`);
  }
}

async function runTest(name, testFn) {
  try {
    await testFn();
    console.log(`✅ ${name}`);
    testsPassed++;
  } catch (error) {
    console.error(`❌ ${name}: ${error.message}`);
    testsFailed++;
  }
}

// Initialize storage for testing
async function setupStorage() {
  const storage = new SQLiteStorageAdapter({ dbPath: TEST_DB_PATH });
  await storage.initialize();
  return storage;
}

// ===== TEST SUITE =====

async function testRegisterPeers() {
  const storage = await setupStorage();
  const registry = new PeerRegistry(storage);

  // Test 1: Register two peers
  const macbook = registry.register({
    agentId: 'macbook-agent',
    machine: 'macbook.local',
    capabilities: ['engineering', 'code-review'],
    endpoint: 'http://macbook:8000'
  });

  assert(macbook.agentId === 'macbook-agent', 'Macbook registration failed');
  assert(macbook.status === 'online', 'Macbook should be online');
  assertEquals(macbook.capabilities.length, 2, 'Macbook should have 2 capabilities');

  const macmini = registry.register({
    agentId: 'macmini-agent',
    machine: 'mac-mini.local',
    capabilities: ['qa', 'testing'],
    endpoint: 'http://macmini:8001'
  });

  assert(macmini.agentId === 'macmini-agent', 'Mac-mini registration failed');
  assertEquals(registry.count(), 2, 'Should have 2 registered peers');
}

async function testListPeers() {
  const storage = await setupStorage();
  const registry = new PeerRegistry(storage);

  // Register peers
  registry.register({
    agentId: 'agent1',
    machine: 'mac1',
    capabilities: ['engineering']
  });

  registry.register({
    agentId: 'agent2',
    machine: 'mac2',
    capabilities: ['qa']
  });

  // Test listing all peers
  const allPeers = registry.listPeers();
  assertEquals(allPeers.length, 2, 'Should list 2 peers');

  // Test filtering by capability
  const engineers = registry.listPeers({ capability: 'engineering' });
  assertEquals(engineers.length, 1, 'Should find 1 engineer');
  assertEquals(engineers[0].agentId, 'agent1', 'Engineer should be agent1');

  // Test filtering by machine
  const mac1Peers = registry.listPeers({ machine: 'mac1' });
  assertEquals(mac1Peers.length, 1, 'Should find 1 peer on mac1');
}

async function testHeartbeatAndStatus() {
  const storage = await setupStorage();
  const registry = new PeerRegistry(storage);

  registry.register({
    agentId: 'test-agent',
    machine: 'test-machine',
    capabilities: ['testing']
  });

  // Send heartbeat with status change
  const heartbeat = registry.heartbeat('test-agent', {
    status: 'busy',
    currentTask: 'running-tests'
  });

  assert(heartbeat !== null, 'Heartbeat should return a result');
  assertEquals(heartbeat.status, 'busy', 'Status should be busy');
  assertEquals(heartbeat.currentTask, 'running-tests', 'Current task should be set');

  // Verify status persisted
  const peer = registry.getPeer('test-agent');
  assertEquals(peer.status, 'busy', 'Peer status should remain busy');
  assertEquals(peer.currentTask, 'running-tests', 'Peer task should persist');
}

async function testSendReceiveMessages() {
  const storage = await setupStorage();
  const registry = new PeerRegistry(storage);
  const messaging = new PeerMessaging(storage);

  // Register peers
  registry.register({
    agentId: 'sender',
    machine: 'mac1',
    capabilities: ['engineering']
  });

  registry.register({
    agentId: 'receiver',
    machine: 'mac2',
    capabilities: ['qa']
  });

  // Send message
  const sent = messaging.sendMessage({
    source: 'sender',
    target: 'receiver',
    message: { type: 'test', data: 'hello' },
    messageType: 'standard'
  });

  assert(sent.messageId, 'Message should have an ID');
  assertEquals(sent.delivered, false, 'Message should not be marked delivered');

  // Check messages on receiver
  const messages = messaging.checkMessages('receiver');
  assertEquals(messages.length, 1, 'Receiver should have 1 message');
  assertEquals(messages[0].source, 'sender', 'Message should be from sender');

  // Verify message marked as delivered
  assert(messages[0].delivered, 'Message should be marked delivered');
}

async function testBroadcast() {
  const storage = await setupStorage();
  const registry = new PeerRegistry(storage);
  const messaging = new PeerMessaging(storage);

  // Register 3 peers
  registry.register({
    agentId: 'broadcaster',
    machine: 'mac1',
    capabilities: ['broadcasting']
  });

  registry.register({
    agentId: 'peer1',
    machine: 'mac2',
    capabilities: ['listening']
  });

  registry.register({
    agentId: 'peer2',
    machine: 'mac3',
    capabilities: ['listening']
  });

  // Broadcast message
  const result = messaging.broadcast(
    {
      source: 'broadcaster',
      message: { type: 'announcement', text: 'test broadcast' },
      messageType: 'broadcast'
    },
    registry
  );

  assertEquals(result.sentCount, 2, 'Should broadcast to 2 peers (excluding self)');
  assertEquals(result.totalPeers, 3, 'Should see 3 total peers');

  // Verify both peers received message
  const peer1Messages = messaging.checkMessages('peer1');
  assertEquals(peer1Messages.length, 1, 'Peer1 should have 1 message');

  const peer2Messages = messaging.checkMessages('peer2');
  assertEquals(peer2Messages.length, 1, 'Peer2 should have 1 message');
}

async function testDeregister() {
  const storage = await setupStorage();
  const registry = new PeerRegistry(storage);

  registry.register({
    agentId: 'temp-agent',
    machine: 'temp-machine',
    capabilities: ['temporary']
  });

  assertEquals(registry.count(), 1, 'Should have 1 peer');

  // Deregister
  const result = registry.deregister('temp-agent');
  assert(result !== null, 'Deregister should return result');

  assertEquals(registry.count(), 0, 'Should have 0 peers after deregister');

  // Verify peer is gone
  const peer = registry.getPeer('temp-agent');
  assert(peer === null, 'Peer should not exist after deregister');
}

async function testCleanupStale() {
  const storage = await setupStorage();
  const registry = new PeerRegistry(storage);

  // Register a peer
  registry.register({
    agentId: 'old-peer',
    machine: 'old-machine',
    capabilities: ['old']
  });

  // Manually mark it as very old in database
  const stmt = storage.db.prepare(`
    UPDATE peers
    SET last_seen = ?
    WHERE agent_id = ?
  `);
  stmt.run(Date.now() - 400000, 'old-peer'); // 400 seconds ago

  // Run cleanup
  const result = registry.cleanupStale();
  assert(result.markedOffline >= 0, 'Cleanup should run');

  // Verify peer is marked offline
  const peer = registry.getPeer('old-peer');
  assertEquals(peer.status, 'offline', 'Stale peer should be marked offline');
}

async function testFullWorkflow() {
  const storage = await setupStorage();
  const registry = new PeerRegistry(storage);
  const messaging = new PeerMessaging(storage);

  // Scenario 1: Register peers with different capabilities
  registry.register({
    agentId: 'macbook-eng',
    machine: 'macbook.local',
    capabilities: ['engineering', 'code-review'],
    metadata: { role: 'engineer' }
  });

  registry.register({
    agentId: 'macmini-qa',
    machine: 'mac-mini.local',
    capabilities: ['qa', 'testing'],
    metadata: { role: 'qa-engineer' }
  });

  // Scenario 2: List and discover by capability
  const engineers = registry.listPeers({ capability: 'engineering' });
  assertEquals(engineers.length, 1, 'Should find 1 engineer');
  assertEquals(engineers[0].agentId, 'macbook-eng', 'Engineer should be macbook');

  // Scenario 3: Heartbeat with status
  registry.heartbeat('macbook-eng', {
    status: 'busy',
    currentTask: 'code-review'
  });

  // Scenario 4: Send message
  messaging.sendMessage({
    source: 'macbook-eng',
    target: 'macmini-qa',
    message: { type: 'test', command: 'run-tests' }
  });

  // Scenario 5: Check messages
  const incomingMessages = messaging.checkMessages('macmini-qa');
  assertEquals(incomingMessages.length, 1, 'QA should have 1 message');

  // Scenario 6: Broadcast
  const broadcastResult = messaging.broadcast(
    {
      source: 'macbook-eng',
      message: { type: 'announcement', text: 'all-hands' }
    },
    registry
  );
  assertEquals(broadcastResult.sentCount, 1, 'Should broadcast to 1 other peer');

  // Scenario 7: Deregister
  registry.deregister('macmini-qa');
  assertEquals(registry.count(), 1, 'Should have 1 peer left');

  // Scenario 8: Cleanup messages
  const cleanupResult = messaging.cleanup({ maxAgeSeconds: 0 });
  assert(cleanupResult.deletedCount >= 0, 'Cleanup should complete');
}

// ===== RUN ALL TESTS =====

async function runAllTests() {
  console.log('🧪 Starting Peer Discovery Integration Tests\n');

  await runTest('Scenario 1: Register 2 peers', testRegisterPeers);
  await runTest('Scenario 2: List peers and filter by capability', testListPeers);
  await runTest('Scenario 3: Heartbeat and status changes', testHeartbeatAndStatus);
  await runTest('Scenario 4: Send and receive messages', testSendReceiveMessages);
  await runTest('Scenario 5: Broadcast to all peers', testBroadcast);
  await runTest('Scenario 6: Deregister peer', testDeregister);
  await runTest('Scenario 7: Cleanup stale peers', testCleanupStale);
  await runTest('Scenario 8: Full workflow', testFullWorkflow);

  // Summary
  console.log(`\n📊 Test Results: ${testsPassed} passed, ${testsFailed} failed`);

  if (testsFailed > 0) {
    process.exit(1);
  }
}

// Run tests
runAllTests().catch((error) => {
  console.error('Test suite error:', error);
  process.exit(1);
});
