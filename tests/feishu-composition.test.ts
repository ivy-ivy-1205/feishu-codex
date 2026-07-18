import { describe, expect, it } from 'vitest';
import { FeishuMessageDeliveryAdapter, FeishuMinutesReaderAdapter } from '../src/adapters/feishu.js';
import { FeishuSdkApiClient, type FeishuSdkClientLike } from '../src/adapters/feishu-sdk.js';
import { createFeishuIntegration } from '../src/composition/feishu.js';

const baseConfig = {
  feishu: {
    appId: 'cli_test_app',
    appSecret: 'test-secret'
  }
} as const;

describe('createFeishuIntegration', () => {
  it('wires the Feishu SDK client into the internal reader and delivery adapters', () => {
    const calls: unknown[] = [];
    const sdkClient = createFakeSdkClient();

    const stack = createFeishuIntegration({
      config: baseConfig,
      createSdkClient: (options) => {
        calls.push(options);
        return sdkClient;
      },
      exposeInternalsForTest: true
    });

    expect(calls).toEqual([{
      appId: 'cli_test_app',
      appSecret: 'test-secret'
    }]);
    expect(stack.reader).toBeInstanceOf(FeishuMinutesReaderAdapter);
    expect(stack.delivery).toBeInstanceOf(FeishuMessageDeliveryAdapter);
    expect(stack.apiClient).toBeInstanceOf(FeishuSdkApiClient);
    expect(stack.sdkClient).toBe(sdkClient);
  });

  it('returns only the safe public Feishu ports outside test inspection mode', () => {
    const integration = createFeishuIntegration({
      config: baseConfig,
      createSdkClient: () => createFakeSdkClient()
    });

    expect(integration.reader).toBeInstanceOf(FeishuMinutesReaderAdapter);
    expect(integration.delivery).toBeInstanceOf(FeishuMessageDeliveryAdapter);
    expect('apiClient' in integration).toBe(false);
    expect('sdkClient' in integration).toBe(false);
  });
});

function createFakeSdkClient(): FeishuSdkClientLike {
  return {
    im: {
      message: {
        create: async () => ({ data: { message_id: 'om_test' } })
      }
    },
    minutes: {
      v1: {
        minute: {
          get: async () => ({ data: {
            title: 'AI Native 周会',
            startedAt: '2026-07-18T02:00:00.000Z',
            endedAt: '2026-07-18T02:30:00.000Z'
          } })
        },
        minuteTranscript: {
          get: async () => []
        }
      }
    }
  };
}
