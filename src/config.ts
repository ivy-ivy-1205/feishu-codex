import { basename } from 'node:path';
import { z } from 'zod';

const commaSeparatedIds = (prefix: string, message: string) =>
  z.string().transform((value) =>
    value.split(',').map((id) => id.trim()).filter(Boolean)
  ).refine((ids) => ids.every((id) => id.startsWith(prefix)), message);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().trim().min(1),
  FEISHU_APP_ID: z.string().trim().min(1),
  FEISHU_APP_SECRET: z.string().trim().min(1),
  FEISHU_VERIFICATION_TOKEN: z.string().trim().min(1),
  FEISHU_ENCRYPT_KEY: z.string().trim().min(1),
  FEISHU_ALLOWED_CHAT_IDS: commaSeparatedIds('oc_', 'chat_id must start with oc_'),
  FEISHU_IVY_PRIVATE_CHAT_ID: z.string().trim().startsWith('oc_', 'chat_id must start with oc_'),
  FEISHU_APPROVER_OPEN_IDS: commaSeparatedIds('ou_', 'open_id must start with ou_'),
  FEISHU_VOICE_TRANSCRIPTION_ENABLED: z.enum(['true', 'false'])
    .transform((value) => value === 'true')
    .default(false),
  WEBHOOK_DEBOUNCE_SECONDS: z.coerce.number().int().positive().default(300),
  CODEX_COMMAND: z.string().trim().min(1).default('codex'),
  CODEX_WORKDIR: z.string().trim().min(1),
  CODEX_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(120)
});

type DatabaseKind = 'postgresql' | 'sqlite';

export interface AppConfig {
  environment: 'development' | 'test' | 'production';
  port: number;
  database: {
    url: string;
    kind: DatabaseKind;
  };
  feishu: {
    appId: string;
    appSecret: string;
    verificationToken: string;
    encryptKey: string;
    allowedChatIds: string[];
    ivyPrivateChatId: string;
    approverOpenIds: string[];
    voiceTranscriptionEnabled: boolean;
    webhookDebounceSeconds: number;
  };
  codex: {
    command: string;
    workdir: string;
    timeoutSeconds: number;
  };
}

export interface PublicConfig {
  environment: AppConfig['environment'];
  port: number;
  databaseKind: DatabaseKind;
  allowedChatCount: number;
  privateChatConfigured: boolean;
  approverCount: number;
  voiceTranscriptionEnabled: boolean;
  codexCommand: string;
}

function databaseKind(url: string): DatabaseKind {
  return url.startsWith('postgres://') || url.startsWith('postgresql://')
    ? 'postgresql'
    : 'sqlite';
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = envSchema.parse(env);

  return {
    environment: parsed.NODE_ENV,
    port: parsed.PORT,
    database: {
      url: parsed.DATABASE_URL,
      kind: databaseKind(parsed.DATABASE_URL)
    },
    feishu: {
      appId: parsed.FEISHU_APP_ID,
      appSecret: parsed.FEISHU_APP_SECRET,
      verificationToken: parsed.FEISHU_VERIFICATION_TOKEN,
      encryptKey: parsed.FEISHU_ENCRYPT_KEY,
      allowedChatIds: parsed.FEISHU_ALLOWED_CHAT_IDS,
      ivyPrivateChatId: parsed.FEISHU_IVY_PRIVATE_CHAT_ID,
      approverOpenIds: parsed.FEISHU_APPROVER_OPEN_IDS,
      voiceTranscriptionEnabled: parsed.FEISHU_VOICE_TRANSCRIPTION_ENABLED,
      webhookDebounceSeconds: parsed.WEBHOOK_DEBOUNCE_SECONDS
    },
    codex: {
      command: parsed.CODEX_COMMAND,
      workdir: parsed.CODEX_WORKDIR,
      timeoutSeconds: parsed.CODEX_TIMEOUT_SECONDS
    }
  };
}

export function publicConfig(config: AppConfig): PublicConfig {
  return {
    environment: config.environment,
    port: config.port,
    databaseKind: config.database.kind,
    allowedChatCount: config.feishu.allowedChatIds.length,
    privateChatConfigured: Boolean(config.feishu.ivyPrivateChatId),
    approverCount: config.feishu.approverOpenIds.length,
    voiceTranscriptionEnabled: config.feishu.voiceTranscriptionEnabled,
    codexCommand: basename(config.codex.command)
  };
}
