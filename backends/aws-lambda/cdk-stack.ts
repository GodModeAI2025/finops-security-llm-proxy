import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { Construct } from "constructs";
import * as path from "path";

export class LlmProxyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── DynamoDB Table (single-table design) ─────────────
    const table = new dynamodb.Table(this, "LlmProxyTable", {
      tableName: "llm-proxy",
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // GSI for listing tokens by status + owner
    table.addGlobalSecondaryIndex({
      indexName: "gsi1",
      partitionKey: { name: "gsi1pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "gsi1sk", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ── Secrets ──────────────────────────────────────────
    const anthropicSecret = new secretsmanager.Secret(this, "AnthropicKey", {
      secretName: "llm-proxy/anthropic-key",
      description: "Anthropic API Key for LLM Proxy",
    });

    const openaiSecret = new secretsmanager.Secret(this, "OpenAIKey", {
      secretName: "llm-proxy/openai-key",
      description: "OpenAI API Key for LLM Proxy",
    });

    const adminSecret = new secretsmanager.Secret(this, "AdminKey", {
      secretName: "llm-proxy/admin-key",
      description: "Admin Key for LLM Proxy /admin/* endpoints",
    });

    // ── Lambda Function ─────────────────────────────────
    const fn = new lambda.Function(this, "LlmProxyFn", {
      functionName: "llm-proxy",
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "handlers/index.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, ".."), {
        bundling: {
          image: lambda.Runtime.NODEJS_20_X.bundlingImage,
          command: [
            "bash", "-c",
            "npm ci && npx tsc && cp -r dist/* /asset-output/ && cd /asset-output && npm ci --omit=dev",
          ],
        },
      }),
      timeout: cdk.Duration.seconds(300),
      memorySize: 512,
      environment: {
        TABLE_NAME: table.tableName,
        NODE_OPTIONS: "--enable-source-maps",
      },
    });

    // Permissions
    table.grantReadWriteData(fn);
    anthropicSecret.grantRead(fn);
    openaiSecret.grantRead(fn);
    adminSecret.grantRead(fn);

    // ── API Gateway (HTTP API) ──────────────────────────
    const api = new apigw.HttpApi(this, "LlmProxyApi", {
      apiName: "llm-proxy",
      description: "LLM API Proxy",
    });

    const integration = new HttpLambdaIntegration("LambdaIntegration", fn);

    // Catch-all route
    api.addRoutes({
      path: "/{proxy+}",
      methods: [apigw.HttpMethod.ANY],
      integration,
    });

    api.addRoutes({
      path: "/",
      methods: [apigw.HttpMethod.GET],
      integration,
    });

    // ── EventBridge (Cleanup Cron) ──────────────────────
    const rule = new events.Rule(this, "CleanupRule", {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      description: "TTL cleanup for expired proxy tokens",
    });
    rule.addTarget(new targets.LambdaFunction(fn));

    // ── Outputs ─────────────────────────────────────────
    new cdk.CfnOutput(this, "ApiUrl", {
      value: api.apiEndpoint,
      description: "API Gateway URL",
    });

    new cdk.CfnOutput(this, "ProxyEndpoint", {
      value: `${api.apiEndpoint}/v1/chat`,
      description: "Proxy endpoint URL",
    });

    new cdk.CfnOutput(this, "TableName", {
      value: table.tableName,
    });
  }
}

// ── CDK App Entry ─────────────────────────────────────────
const app = new cdk.App();
new LlmProxyStack(app, "LlmProxyStack", {
  env: {
    region: process.env.CDK_DEFAULT_REGION ?? "eu-central-1",
    account: process.env.CDK_DEFAULT_ACCOUNT,
  },
});
