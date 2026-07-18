import {
  FeishuMessageDeliveryAdapter,
  FeishuMinutesReaderAdapter
} from '../adapters/feishu.js';
import {
  createFeishuSdkClient,
  FeishuSdkApiClient,
  type FeishuSdkClientLike,
  type FeishuSdkClientOptions
} from '../adapters/feishu-sdk.js';

export interface FeishuIntegrationCompositionConfig {
  feishu: {
    appId: string;
    appSecret: string;
  };
}

export interface FeishuIntegration {
  reader: FeishuMinutesReaderAdapter;
  delivery: FeishuMessageDeliveryAdapter;
}

export interface CreateFeishuIntegrationOptions {
  config: FeishuIntegrationCompositionConfig;
  createSdkClient?: (options: FeishuSdkClientOptions) => FeishuSdkClientLike;
  exposeInternalsForTest?: false;
}

export interface CreateFeishuIntegrationTestOptions {
  config: FeishuIntegrationCompositionConfig;
  createSdkClient?: (options: FeishuSdkClientOptions) => FeishuSdkClientLike;
  exposeInternalsForTest: true;
}

export interface FeishuIntegrationStackForTest extends FeishuIntegration {
  sdkClient: FeishuSdkClientLike;
  apiClient: FeishuSdkApiClient;
}

export function createFeishuIntegration(
  options: CreateFeishuIntegrationTestOptions
): FeishuIntegrationStackForTest;
export function createFeishuIntegration(
  options: CreateFeishuIntegrationOptions
): FeishuIntegration;
export function createFeishuIntegration(
  options: CreateFeishuIntegrationOptions | CreateFeishuIntegrationTestOptions
): FeishuIntegration | FeishuIntegrationStackForTest {
  const createSdk = options.createSdkClient ?? createFeishuSdkClient;
  const sdkClient = createSdk({
    appId: options.config.feishu.appId,
    appSecret: options.config.feishu.appSecret
  });
  const apiClient = new FeishuSdkApiClient({ sdkClient });
  const reader = new FeishuMinutesReaderAdapter(apiClient);
  const delivery = new FeishuMessageDeliveryAdapter(apiClient);

  if (options.exposeInternalsForTest) {
    return {
      reader,
      delivery,
      sdkClient,
      apiClient
    };
  }

  return {
    reader,
    delivery
  };
}
