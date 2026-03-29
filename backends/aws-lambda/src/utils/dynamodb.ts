import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { v4 as uuidv4 } from "uuid";
import { TokenItem, UsageItem, CreateTokenRequest } from "../types";

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);
const TABLE = process.env.TABLE_NAME || "llm-proxy";

export async function putItem(item: Record<string, any>): Promise<void> {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
}

// ============================================================
// Token CRUD
// ============================================================

export async function createToken(req: CreateTokenRequest): Promise<TokenItem> {
  const id = `ptk_${uuidv4().replace(/-/g, "").slice(0, 16)}`;
  const now = new Date().toISOString();

  const token: TokenItem = {
    pk: `TOKEN#${id}`,
    sk: "META",
    id,
    name: req.name,
    owner: req.owner,
    status: "active",
    revoke_reason: null,
    created_at: now,
    revoked_at: null,
    ttl_expires_at: req.rules?.ttl_expires_at ?? null,
    max_budget_usd: req.rules?.max_budget_usd ?? 100,
    max_requests_per_min: req.rules?.max_requests_per_min ?? 60,
    max_tokens_per_request: req.rules?.max_tokens_per_request ?? 4096,
    max_fail_streak: req.rules?.max_fail_streak ?? 10,
    allowed_providers: req.scope?.allowed_providers ?? ["anthropic", "openai"],
    allowed_models: req.scope?.allowed_models ?? ["*"],
    gsi1pk: "STATUS#active",
    gsi1sk: req.owner,
  };

  const usage: UsageItem = {
    pk: `TOKEN#${id}`,
    sk: "USAGE",
    total_requests: 0,
    successful_requests: 0,
    failed_requests: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cost_usd: 0,
    fail_streak: 0,
    last_request_at: null,
    by_provider: {},
  };

  await Promise.all([
    ddb.send(new PutCommand({ TableName: TABLE, Item: token })),
    ddb.send(new PutCommand({ TableName: TABLE, Item: usage })),
  ]);
  return token;
}

export async function getToken(id: string): Promise<TokenItem | null> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: `TOKEN#${id}`, sk: "META" } }));
  return (res.Item as TokenItem) ?? null;
}

export async function getUsage(id: string): Promise<UsageItem | null> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: `TOKEN#${id}`, sk: "USAGE" } }));
  return (res.Item as UsageItem) ?? null;
}

export async function deleteToken(id: string): Promise<void> {
  await Promise.all([
    ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk: `TOKEN#${id}`, sk: "META" } })),
    ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk: `TOKEN#${id}`, sk: "USAGE" } })),
  ]);
}

export async function listTokens(status?: string, owner?: string): Promise<TokenItem[]> {
  if (status) {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        IndexName: "gsi1",
        KeyConditionExpression: owner
          ? "gsi1pk = :status AND gsi1sk = :owner"
          : "gsi1pk = :status",
        ExpressionAttributeValues: owner
          ? { ":status": `STATUS#${status}`, ":owner": owner }
          : { ":status": `STATUS#${status}` },
      })
    );
    return (res.Items as TokenItem[]) ?? [];
  }
  // Without filter: query both statuses and merge
  const [activeRes, revokedRes] = await Promise.all([
    ddb.send(new QueryCommand({
      TableName: TABLE, IndexName: "gsi1",
      KeyConditionExpression: "gsi1pk = :status",
      ExpressionAttributeValues: { ":status": "STATUS#active" },
    })),
    ddb.send(new QueryCommand({
      TableName: TABLE, IndexName: "gsi1",
      KeyConditionExpression: "gsi1pk = :status",
      ExpressionAttributeValues: { ":status": "STATUS#revoked" },
    })),
  ]);
  return [...(activeRes.Items ?? []), ...(revokedRes.Items ?? [])] as TokenItem[];
}

// ============================================================
// Revocation
// ============================================================

export async function revokeToken(id: string, reason: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: `TOKEN#${id}`, sk: "META" },
      UpdateExpression: "SET #status = :revoked, revoke_reason = :reason, revoked_at = :now, gsi1pk = :gsi",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":revoked": "revoked",
        ":reason": reason,
        ":now": new Date().toISOString(),
        ":gsi": "STATUS#revoked",
      },
    })
  );
}

export async function reactivateToken(id: string): Promise<void> {
  await Promise.all([
    ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: `TOKEN#${id}`, sk: "META" },
      UpdateExpression: "SET #status = :active, revoke_reason = :null, revoked_at = :null, gsi1pk = :gsi",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":active": "active", ":null": null, ":gsi": "STATUS#active" },
    })),
    ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: `TOKEN#${id}`, sk: "USAGE" },
      UpdateExpression: "SET fail_streak = :zero",
      ExpressionAttributeValues: { ":zero": 0 },
    })),
  ]);
}

// ============================================================
// Usage tracking (atomic via DynamoDB UpdateExpression)
// ============================================================

export async function trackUsage(
  tokenId: string,
  provider: string,
  inputTokens: number,
  outputTokens: number,
  cost: number,
  success: boolean
): Promise<UsageItem> {
  const successExpr = success
    ? "SET fail_streak = :zero, successful_requests = successful_requests + :one"
    : "SET fail_streak = fail_streak + :one, failed_requests = failed_requests + :one";

  const res = await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: `TOKEN#${tokenId}`, sk: "USAGE" },
      UpdateExpression: `
        ${successExpr},
        total_requests = total_requests + :one,
        total_input_tokens = total_input_tokens + :inputT,
        total_output_tokens = total_output_tokens + :outputT,
        total_cost_usd = total_cost_usd + :cost,
        last_request_at = :now
      `,
      ExpressionAttributeValues: {
        ":one": 1,
        ":zero": 0,
        ":inputT": inputTokens,
        ":outputT": outputTokens,
        ":cost": cost,
        ":now": new Date().toISOString(),
      },
      ReturnValues: "ALL_NEW",
    })
  );

  // Update per-provider breakdown separately (nested map updates)
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: `TOKEN#${tokenId}`, sk: "USAGE" },
      UpdateExpression: `
        SET by_provider.#prov = if_not_exists(by_provider.#prov, :empty)
      `,
      ExpressionAttributeNames: { "#prov": provider },
      ExpressionAttributeValues: { ":empty": { requests: 0, cost_usd: 0 } },
    })
  );

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: `TOKEN#${tokenId}`, sk: "USAGE" },
      UpdateExpression: `
        SET by_provider.#prov.requests = by_provider.#prov.requests + :one,
            by_provider.#prov.cost_usd = by_provider.#prov.cost_usd + :cost
      `,
      ExpressionAttributeNames: { "#prov": provider },
      ExpressionAttributeValues: { ":one": 1, ":cost": cost },
    })
  );

  return res.Attributes as UsageItem;
}

export async function recordFeedback(tokenId: string, success: boolean): Promise<number> {
  const expr = success
    ? "SET fail_streak = :zero"
    : "SET fail_streak = fail_streak + :one";

  const res = await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: `TOKEN#${tokenId}`, sk: "USAGE" },
      UpdateExpression: expr,
      ExpressionAttributeValues: success ? { ":zero": 0 } : { ":one": 1 },
      ReturnValues: "ALL_NEW",
    })
  );

  return (res.Attributes as UsageItem).fail_streak;
}

// ============================================================
// TTL Cleanup
// ============================================================

export async function cleanupExpired(): Promise<number> {
  const tokens = await listTokens("active");
  const now = new Date();
  let count = 0;

  const expired = tokens.filter(
    (t) => t.ttl_expires_at && new Date(t.ttl_expires_at) <= now
  );
  await Promise.all(expired.map((t) => revokeToken(t.id, "ttl_expired")));

  return expired.length;
}
