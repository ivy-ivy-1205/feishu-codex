import { basename } from 'node:path';
import { z } from 'zod';

const commaSeparatedIds = (prefix: string, message: string) =>
  z.string().transform((value) =>
    value.split(',').map((id) => id.trim()).filter(Boolean)
  ).refine((ids) => ids.every((id) => id.startsWith(prefix)), message);

const approvedProjectContextChatId = 'oc_a84d5b6ca478220d0a37964b50776edb';
const projectContextChatIds = commaSeparatedIds('oc_', 'chat_id must start with oc_')
  .refine(
    (ids) => ids.every((id) => id === approvedProjectContextChatId),
    'only approved project context chat_id may be configured'
  );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().trim().min(1).default('127.0.0.1'),
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
  FEISHU_OAUTH_ENABLED: z.enum(['true', 'false']).transform((value) => value === 'true').default(false),
  FEISHU_OAUTH_REDIRECT_URI: z.string().trim().url().optional(),
  FEISHU_OAUTH_TOKEN_KEY_FILE: z.string().trim().min(1).optional(),
  FEISHU_OAUTH_SCOPES: z.string().trim()
    .default('auth:user.id:read,offline_access,minutes:minutes.basic:read,minutes:minutes.transcript:export'),
  FEISHU_OAUTH_STALE_EVENT_HOURS: z.coerce.number().positive().default(24),
  WEBHOOK_DEBOUNCE_SECONDS: z.coerce.number().int().positive().default(300),
  CODEX_COMMAND: z.string().trim().min(1).default('codex'),
  CODEX_WORKDIR: z.string().trim().min(1),
  CODEX_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(120),
  CODEX_SUMMARIZER_MODE: z.enum(['fake', 'codex']).default('fake'),
  WORKER_ENABLED: z.enum(['true', 'false']).transform((value) => value === 'true').default(false),
  WORKER_LEASE_SECONDS: z.coerce.number().int().positive().default(180),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),
  PROJECT_CONTEXT_SYNC_ENABLED: z.enum(['true', 'false']).transform((value) => value === 'true').default(false),
  PROJECT_CONTEXT_CHAT_IDS: projectContextChatIds.default([]),
  PROJECT_CONTEXT_SYNC_SINCE_DAYS: z.coerce.number().int().positive().default(30)
}).superRefine((config, context) => {
  if (
    config.NODE_ENV !== 'test' &&
    /fixture|placeholder|change[-_ ]?me|replace[-_ ]?me/iu.test(
      config.FEISHU_VERIFICATION_TOKEN
    )
  ) {
    context.addIssue({
      code: 'custom',
      path: ['FEISHU_VERIFICATION_TOKEN'],
      message: 'fixture verification token is allowed only in NODE_ENV=test'
    });
  }
  if (config.WORKER_LEASE_SECONDS <= config.CODEX_TIMEOUT_SECONDS) {
    context.addIssue({
      code: 'custom',
      path: ['WORKER_LEASE_SECONDS'],
      message: 'worker lease must be longer than the downstream timeout'
    });
  }
  if (config.FEISHU_OAUTH_ENABLED && !config.FEISHU_OAUTH_REDIRECT_URI) {
    context.addIssue({
      code: 'custom',
      path: ['FEISHU_OAUTH_REDIRECT_URI'],
      message: 'Feishu OAuth redirect URI is required when OAuth is enabled'
    });
  }
  if (config.FEISHU_OAUTH_ENABLED && !config.FEISHU_OAUTH_TOKEN_KEY_FILE) {
    context.addIssue({
      code: 'custom',
      path: ['FEISHU_OAUTH_TOKEN_KEY_FILE'],
      message: 'Feishu OAuth token key file is required when OAuth is enabled'
    });
  }
});

type DatabaseKind = 'postgresql' | 'sqlite';

export interface AppConfig {
  environment: 'development' | 'test' | 'production';
  host: string;
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
    oauth: {
      enabled: boolean;
      redirectUri: string | null;
      tokenKeyFile: string | null;
      scopes: string[];
      staleEventHours: number;
    };
  };
  codex: {
    command: string;
    workdir: string;
    timeoutSeconds: number;
    summarizerMode: 'fake' | 'codex';
  };
  worker: {
    enabled: boolean;
    leaseSeconds: number;
    pollIntervalMs: number;
  };
  projectContext: {
    syncEnabled: boolean;
    approvedChatIds: string[];
    syncSinceDays: number;
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
    host: parsed.HOST,
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
      webhookDebounceSeconds: parsed.WEBHOOK_DEBOUNCE_SECONDS,
      oauth: {
        enabled: parsed.FEISHU_OAUTH_ENABLED,
        redirectUri: parsed.FEISHU_OAUTH_REDIRECT_URI ?? null,
        tokenKeyFile: parsed.FEISHU_OAUTH_TOKEN_KEY_FILE ?? null,
        scopes: parsed.FEISHU_OAUTH_SCOPES.split(',').map((scope) => scope.trim()).filter(Boolean),
        staleEventHours: parsed.FEISHU_OAUTH_STALE_EVENT_HOURS
      }
    },
    codex: {
      command: parsed.CODEX_COMMAND,
      workdir: parsed.CODEX_WORKDIR,
      timeoutSeconds: parsed.CODEX_TIMEOUT_SECONDS,
      summarizerMode: parsed.CODEX_SUMMARIZER_MODE
    },
    worker: {
      enabled: parsed.WORKER_ENABLED,
      leaseSeconds: parsed.WORKER_LEASE_SECONDS,
      pollIntervalMs: parsed.WORKER_POLL_INTERVAL_MS
    },
    projectContext: {
      syncEnabled: parsed.PROJECT_CONTEXT_SYNC_ENABLED,
      approvedChatIds: parsed.PROJECT_CONTEXT_CHAT_IDS,
      syncSinceDays: parsed.PROJECT_CONTEXT_SYNC_SINCE_DAYS
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
