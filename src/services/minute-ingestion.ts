import { MinuteGeneratedEvent } from '../domain/meeting.js';
import { JobRepository } from '../repositories/job-repository.js';
import { MeetingRepository } from '../repositories/meeting-repository.js';

const minuteGeneratedEventType = 'minutes.minute.generated_v1';

export interface MinuteIngestionDependencies {
  meetingRepository: MeetingRepository;
  jobRepository: JobRepository;
}

export interface IngestionResult {
  status: 'accepted' | 'duplicate' | 'ignored';
}

export function ingestMinuteGenerated(
  event: unknown,
  dependencies: MinuteIngestionDependencies
): IngestionResult {
  const envelope = event as MinuteGeneratedEnvelope;
  if (envelope.header?.event_type !== minuteGeneratedEventType) {
    return { status: 'ignored' };
  }

  if (dependencies.meetingRepository.client !== dependencies.jobRepository.client) {
    throw new Error('minute ingestion repositories must use the same SQLite client');
  }

  const minuteEvent = MinuteGeneratedEvent.parse({
    eventId: envelope.header.event_id,
    minuteId: extractMinuteToken(envelope.event),
    occurredAt: normalizeFeishuEventTime(envelope.header.create_time)
  });
  const ingested = dependencies.meetingRepository.ingestMinute(minuteEvent, () => {
    dependencies.jobRepository.enqueueProcessMinute(minuteEvent.minuteId);
  });

  return { status: ingested.created ? 'accepted' : 'duplicate' };
}

interface MinuteGeneratedEnvelope {
  header?: {
    event_id?: unknown;
    event_type?: unknown;
    create_time?: unknown;
  };
  event?: {
    minute_token?: unknown;
    minute?: {
      minute_token?: unknown;
    };
  };
}

function extractMinuteToken(event: MinuteGeneratedEnvelope['event']): unknown {
  if (typeof event?.minute_token === 'string' && event.minute_token.trim().length > 0) {
    return event.minute_token;
  }
  return event?.minute?.minute_token;
}

function normalizeFeishuEventTime(createTime: unknown): unknown {
  if (typeof createTime !== 'string') {
    return createTime;
  }
  const trimmed = createTime.trim();
  if (/^\d+$/.test(trimmed)) {
    const timestamp = Number(trimmed);
    if (Number.isSafeInteger(timestamp)) {
      return new Date(timestamp).toISOString();
    }
  }
  return createTime;
}
