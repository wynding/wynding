// The survey handler's storage: one DynamoDB item per submission, written in a transaction with
// the day's quota counter (wynding-site ADR 0001 §3, §6, §7).
//
//   survey#<idempotencyKey>  the submission. It IS the idempotency record: a conditional put
//                            (`attribute_not_exists(pk)`) stores a new key and refuses a reused
//                            one, so a retry is stored once and nothing is ever overwritten.
//   quota#<UTC date>         the day's counter, `ADD n :one` under
//                            `attribute_not_exists(n) OR n < :ceiling`, so the first
//                            submission of a day creates it and the ceiling fails closed.
//
// A transaction applies both writes or neither. When it is cancelled, the cancellation reasons
// say which condition failed, and the put's comes first: a reused key is a DUPLICATE (accepted,
// consuming no quota) even when the counter's condition also failed, so a lost-acknowledgement
// retry on a day at the ceiling is not refused. Anything else (the counter alone, a conflict
// between concurrent requests, a throttle) is a 503.

import {
  DynamoDBClient,
  TransactWriteItemsCommand,
  type TransactWriteItemsCommandInput,
} from '@aws-sdk/client-dynamodb';

/** How long an item lives before TTL removes it. 80 days, so that DynamoDB's lazy TTL deletion
 *  (and the daily sweep behind it) keeps actual deletion inside the notice's 90. */
export const SURVEY_TTL_DAYS = 80;
/** The day counter's lifetime: long enough to outlive its day, short enough to vanish. */
export const QUOTA_TTL_DAYS = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SurveySubmission {
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly runId: string;
  /** The validated payload, serialized: stored as one string so DynamoDB's type mapping never
   *  reshapes it (an empty `text` would otherwise need special handling). */
  readonly payloadJson: string;
  readonly noticeVersion: string;
  readonly receivedAtMs: number;
  readonly dailyCeiling: number;
}

export type PutOutcome = 'stored' | 'duplicate' | 'ceiling' | 'throttled';

export interface SurveyStore {
  put(submission: SurveySubmission): Promise<PutOutcome>;
}

/** The slice of `DynamoDBClient` the store uses, so tests can stand in for it. */
export interface TransactWriter {
  send(command: TransactWriteItemsCommand): Promise<unknown>;
}

/** The two writes, as one transaction. Exported so the exact request is testable. */
export function surveyTransaction(
  tableName: string,
  submission: SurveySubmission,
): TransactWriteItemsCommandInput {
  const received = submission.receivedAtMs;
  const day = new Date(received).toISOString().slice(0, 10);
  const seconds = (ms: number): string => String(Math.floor(ms / 1000));
  return {
    TransactItems: [
      {
        Put: {
          TableName: tableName,
          Item: {
            pk: { S: `survey#${submission.idempotencyKey}` },
            sessionId: { S: submission.sessionId },
            runId: { S: submission.runId },
            payload: { S: submission.payloadJson },
            noticeVersion: { S: submission.noticeVersion },
            receivedAt: { S: new Date(received).toISOString() },
            expiresAt: { N: seconds(received + SURVEY_TTL_DAYS * DAY_MS) },
            moderation: { S: 'pending' },
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
      {
        Update: {
          TableName: tableName,
          Key: { pk: { S: `quota#${day}` } },
          UpdateExpression: 'ADD n :one SET expiresAt = :expires',
          ConditionExpression: 'attribute_not_exists(n) OR n < :ceiling',
          ExpressionAttributeValues: {
            ':one': { N: '1' },
            ':ceiling': { N: String(submission.dailyCeiling) },
            ':expires': { N: seconds(received + QUOTA_TTL_DAYS * DAY_MS) },
          },
        },
      },
    ],
  };
}

interface CancellationReason {
  readonly Code?: string;
}

/** Map a rejected transaction to an outcome, or rethrow what is not a DynamoDB refusal. */
export function classifyFailure(error: unknown): PutOutcome {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'TransactionCanceledException') {
    const reasons = (error as { CancellationReasons?: readonly CancellationReason[] })
      .CancellationReasons;
    if (reasons?.[0]?.Code === 'ConditionalCheckFailed') return 'duplicate';
    if (reasons?.[1]?.Code === 'ConditionalCheckFailed') return 'ceiling';
    return 'throttled';
  }
  if (
    name === 'ProvisionedThroughputExceededException' ||
    name === 'ThrottlingException' ||
    name === 'RequestLimitExceeded'
  ) {
    return 'throttled';
  }
  throw error;
}

export function createDynamoSurveyStore(options: {
  readonly tableName: string;
  readonly client?: TransactWriter;
}): SurveyStore {
  let client = options.client ?? null;
  return {
    async put(submission) {
      client ??= new DynamoDBClient({});
      try {
        await client.send(
          new TransactWriteItemsCommand(surveyTransaction(options.tableName, submission)),
        );
        return 'stored';
      } catch (error) {
        return classifyFailure(error);
      }
    },
  };
}
