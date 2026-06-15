import { UpdateCommand } from '@aws-sdk/lib-dynamodb';

// Per-IP fixed-window counters living in the books table; the table TTL
// sweeps the rows. Launch abuse control — WAF deliberately deferred
// (docs/plan-multi-user-cognito.md, trade-offs).
export const LIMITS = {
  signup:  { limit: 5,  windowSeconds: 3600 },
  login:   { limit: 10, windowSeconds: 900 },
  confirm: { limit: 10, windowSeconds: 3600 },
  forgot:  { limit: 5,  windowSeconds: 3600 },
};

export function makeRateLimiter({
  ddb, table = process.env.TABLE_NAME, now = () => Date.now(),
} = {}) {
  return async function allow(scope, key, { limit, windowSeconds }) {
    const windowId = Math.floor(now() / 1000 / windowSeconds);
    const out = await ddb.send(new UpdateCommand({
      TableName: table,
      Key: { pk: `RL#${scope}#${key}#${windowId}`, id: 'rl' },
      UpdateExpression: 'ADD #c :one SET #t = if_not_exists(#t, :exp)',
      ExpressionAttributeNames: { '#c': 'count', '#t': 'ttl' },
      ExpressionAttributeValues: {
        ':one': 1,
        ':exp': Math.floor(now() / 1000) + windowSeconds * 2,
      },
      ReturnValues: 'ALL_NEW',
    }));
    return (out.Attributes?.count ?? 1) <= limit;
  };
}
