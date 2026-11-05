// skipKgNode: a contact created for a bulk import gets no knowledge-graph node (no person node, no organization routing,
// no adoption), so importing thousands of people does not add thousands of edgeless nodes. A node is linked later, when
// a person is worth keeping. Real in-memory entity memory, so a node that is wrongly created would show.

import { describe, it, expect, beforeEach } from 'vitest';
import { ContactService } from '../../../src/contacts/contact-service.js';
import { ContactImportService } from '../../../src/contacts-import/import-service.js';
import { InMemoryImportStore } from '../../../src/contacts-import/import-store.js';
import { KnowledgeGraphStore } from '../../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../../src/memory/embedding.js';
import { EntityMemory } from '../../../src/memory/entity-memory.js';
import { MemoryValidator } from '../../../src/memory/validation.js';
import { createSilentLogger } from '../../../src/logger.js';

describe('createContact skipKgNode', () => {
  let service: ContactService;
  let store: KnowledgeGraphStore;
  let entityMemory: EntityMemory;
  const nodeCount = async () => (await store.findNodesByType('person')).length + (await store.findNodesByType('organization')).length;

  beforeEach(() => {
    const embeddingService = EmbeddingService.createForTesting();
    store = KnowledgeGraphStore.createInMemory(embeddingService);
    entityMemory = new EntityMemory(store, new MemoryValidator(store, embeddingService), embeddingService, createSilentLogger());
    service = ContactService.createInMemory(entityMemory, undefined, createSilentLogger());
  });

  it('control: without the option a contact gets a graph node', async () => {
    const c = await service.createContact({ displayName: 'Dana Lee', source: 'test' });
    expect(c.kgNodeId).not.toBeNull();
    expect(await nodeCount()).toBeGreaterThan(0);
  });

  it('with the option the contact has no node and the graph is untouched', async () => {
    const c = await service.createContact({ displayName: 'Dana Lee', source: 'test', skipKgNode: true });
    expect(c.kgNodeId).toBeNull();
    expect(await nodeCount()).toBe(0);
    expect((await service.getContact(c.id))?.kgNodeId).toBeNull();
  });

  it('an organisation-looking email does not create an organisation node either', async () => {
    const c = await service.createContact({ displayName: 'Support Team', source: 'test', primaryEmail: 'support@acme-widgets.example', skipKgNode: true });
    expect(c.kgNodeId).toBeNull();
    expect(await nodeCount()).toBe(0);
  });

  it('two people with the same name are both fine without nodes', async () => {
    const a = await service.createContact({ displayName: 'Dana Lee', source: 'test', skipKgNode: true });
    const b = await service.createContact({ displayName: 'Dana Lee', source: 'test', skipKgNode: true });
    expect([a.kgNodeId, b.kgNodeId]).toEqual([null, null]);
  });

  it('an explicit kgNodeId still wins over skipKgNode', async () => {
    const { entity } = await entityMemory.createEntity({ type: 'person', label: 'Unowned Person', properties: {}, source: 'test' });
    const c = await service.createContact({ displayName: 'Other Name', source: 'test', kgNodeId: entity.id, skipKgNode: true });
    expect(c.kgNodeId).toBe(entity.id);
  });

  it('the contacts import creates people without graph nodes, as unknown, even for an org-looking email', async () => {
    const importer = new ContactImportService(service, new InMemoryImportStore(), createSilentLogger());
    await importer.plan('b1', [
      { sourceKey: 'a', displayName: 'Dana Lee', emails: ['dana@acme-widgets.example'] },
      { sourceKey: 'b', displayName: 'Bo Chen', phones: ['+14165550101'] },
    ]);
    const result = await importer.apply('b1', [
      { sourceKey: 'a', displayName: 'Dana Lee', emails: ['dana@acme-widgets.example'] },
      { sourceKey: 'b', displayName: 'Bo Chen', phones: ['+14165550101'] },
    ]);
    expect(result.counts.created).toBe(2);
    const made = (await service.listContacts()).filter((c) => c.displayName === 'Dana Lee' || c.displayName === 'Bo Chen');
    expect(made).toHaveLength(2);
    expect(made.every((c) => c.kgNodeId === null && c.tier === 'unknown')).toBe(true);
    expect(await nodeCount()).toBe(0);
  });
});
