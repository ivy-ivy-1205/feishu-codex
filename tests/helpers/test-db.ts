import { createSqliteDatabase } from '../../src/db/client.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { MeetingRepository } from '../../src/repositories/meeting-repository.js';

export function createTestMeetingRepository(): MeetingRepository {
  const database = createSqliteDatabase(':memory:');
  migrateDatabase(database.client);
  return new MeetingRepository(database.client);
}
