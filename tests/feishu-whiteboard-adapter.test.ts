import { describe, expect, it } from 'vitest';
import { createFeishuWhiteboardGateway } from '../src/adapters/feishu-whiteboard.js';

describe('Feishu whiteboard adapter', () => {
  it('creates a docx board, batches native nodes, and grants the group edit access', async () => {
    const calls: { documents: unknown[]; blocks: unknown[]; nodeBatches: unknown[]; grants: unknown[] } = {
      documents: [], blocks: [], nodeBatches: [], grants: []
    };
    const sdk = {
      docx: { v1: {
        document: { async create(payload: unknown) {
          calls.documents.push(payload);
          return { code: 0, data: { document: { document_id: 'doc_1' } } };
        } },
        documentBlockChildren: { async create(payload: unknown) {
          calls.blocks.push(payload);
          return { code: 0, data: { children: [{ board: { token: 'board_1' } }] } };
        } }
      } },
      board: { v1: { whiteboardNode: { async create(payload: unknown) {
        calls.nodeBatches.push(payload);
        return { code: 0, data: { ids: ['node_1'] } };
      } } } },
      drive: { v1: { permissionMember: { async create(payload: unknown) {
        calls.grants.push(payload);
        return { code: 0, data: { member: { member_id: 'oc_group' } } };
      } } } }
    };
    const gateway = createFeishuWhiteboardGateway(sdk);
    const nodes = Array.from({ length: 51 }, (_, index) => ({
      id: `node_${index}`,
      type: 'text_shape' as const,
      x: index,
      y: 0,
      width: 100,
      height: 40,
      text: { text: `Line ${index}` }
    }));

    expect(await gateway.createDocument({ title: '工作地图' })).toEqual({ documentId: 'doc_1' });
    expect(await gateway.createBoard({ documentId: 'doc_1', width: 1800, height: 1200 }))
      .toEqual({ whiteboardId: 'board_1' });
    await gateway.createNodes({ whiteboardId: 'board_1', nodes });
    await gateway.grantGroupEdit({ documentId: 'doc_1', chatId: 'oc_group' });

    expect(calls.documents).toEqual([{ data: { title: '工作地图' } }]);
    expect(calls.blocks).toEqual([{ path: { document_id: 'doc_1', block_id: 'doc_1' },
      data: { children: [{ block_type: 43, board: { align: 1, width: 1800, height: 1200 } }] } }]);
    expect(calls.nodeBatches).toHaveLength(2);
    expect(calls.nodeBatches).toEqual([
      expect.objectContaining({ path: { whiteboard_id: 'board_1' }, data: { nodes: nodes.slice(0, 50) } }),
      expect.objectContaining({ path: { whiteboard_id: 'board_1' }, data: { nodes: nodes.slice(50) } })
    ]);
    expect(calls.grants).toEqual([{ path: { token: 'doc_1' }, params: { type: 'docx', need_notification: false },
      data: { member_type: 'openchat', member_id: 'oc_group', perm: 'edit', perm_type: 'container' } }]);
  });

  it('fails closed when Feishu omits required identifiers or returns an error code', async () => {
    const missingDocument = createFeishuWhiteboardGateway({
      docx: { v1: { document: { async create() { return { code: 0, data: {} }; } },
        documentBlockChildren: { async create() { return { code: 0, data: {} }; } } } },
      board: { v1: { whiteboardNode: { async create() { return { code: 0 }; } } } },
      drive: { v1: { permissionMember: { async create() { return { code: 0 }; } } } }
    });
    await expect(missingDocument.createDocument({ title: '工作地图' }))
      .rejects.toThrow(/document id/i);

    const failedNodeCreate = createFeishuWhiteboardGateway({
      docx: { v1: { document: { async create() { return { code: 0, data: { document: { document_id: 'doc' } } }; } },
        documentBlockChildren: { async create() { return { code: 0, data: { children: [{ board: { token: 'board' } }] } }; } } } },
      board: { v1: { whiteboardNode: { async create() { return { code: 999, msg: 'denied' }; } } } },
      drive: { v1: { permissionMember: { async create() { return { code: 0 }; } } } }
    });
    await expect(failedNodeCreate.createNodes({ whiteboardId: 'board', nodes: [{ id: 'n', type: 'text_shape' }] }))
      .rejects.toThrow(/denied/i);
  });
});
