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
    minuteId: envelope.event?.minute?.minute_token,
    occurredAt: envelope.header.create_time
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
    minute?: {
      minute_token?: unknown;
    };
  };
}
