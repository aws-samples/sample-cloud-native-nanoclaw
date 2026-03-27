import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type { Construct } from 'constructs';

export interface AgentStackProps extends cdk.StackProps {
  stage: string;
  dataBucket: s3.IBucket;
  messageQueue: sqs.IQueue;
  replyQueue: sqs.IQueue;
  tables: {
    users: dynamodb.ITable;
    bots: dynamodb.ITable;
    channels: dynamodb.ITable;
    groups: dynamodb.ITable;
    messages: dynamodb.ITable;
    tasks: dynamodb.ITable;
    sessions: dynamodb.ITable;
  };
}

export class AgentStack extends cdk.Stack {
  public readonly agentBaseRole: iam.Role;
  public readonly agentScopedRole: iam.Role;
  public readonly schedulerRole: iam.Role;

  constructor(scope: Construct, id: string, props: AgentStackProps) {
    super(scope, id, props);

    const { stage, dataBucket, messageQueue, replyQueue, tables } = props;

    // ── Agent Base Role (created first so scoped role can trust it) ─────
    this.agentBaseRole = new iam.Role(this, 'AgentBaseRole', {
      roleName: `NanoClawBotAgentBaseRole-${stage}`,
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
    });

    // ── Agent Scoped Role (only assumable by base role, NOT by ecs-tasks) ─
    this.agentScopedRole = new iam.Role(this, 'AgentScopedRole', {
      roleName: `NanoClawBotAgentScopedRole-${stage}`,
      assumedBy: new iam.ArnPrincipal(this.agentBaseRole.roleArn),
    });

    // Bedrock InvokeModel — all models and inference profiles
    this.agentBaseRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'BedrockInvokeModel',
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: ['*'],
      }),
    );

    // STS AssumeRole on the scoped role
    this.agentBaseRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AssumeScopedRole',
        effect: iam.Effect.ALLOW,
        actions: ['sts:AssumeRole', 'sts:TagSession'],
        resources: [this.agentScopedRole.roleArn],
      }),
    );

    // SQS SendMessage on reply queue
    this.agentBaseRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SqsSendReply',
        effect: iam.Effect.ALLOW,
        actions: ['sqs:SendMessage'],
        resources: [replyQueue.queueArn],
      }),
    );

    // ECR pull permissions (required by AgentCore to validate and pull container image)
    this.agentBaseRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EcrPull',
        effect: iam.Effect.ALLOW,
        actions: [
          'ecr:GetAuthorizationToken',
          'ecr:BatchGetImage',
          'ecr:GetDownloadUrlForLayer',
        ],
        resources: ['*'],
      }),
    );

    // CloudWatch Logs — required by AgentCore to write runtime container logs
    this.agentBaseRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CloudWatchLogsCreate',
        effect: iam.Effect.ALLOW,
        actions: ['logs:CreateLogGroup', 'logs:DescribeLogStreams'],
        resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*`],
      }),
    );
    this.agentBaseRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CloudWatchLogsDescribe',
        effect: iam.Effect.ALLOW,
        actions: ['logs:DescribeLogGroups'],
        resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:*`],
      }),
    );
    this.agentBaseRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CloudWatchLogsPut',
        effect: iam.Effect.ALLOW,
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*`],
      }),
    );

    // CloudWatch Metrics — AgentCore runtime metrics
    this.agentBaseRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CloudWatchMetrics',
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'cloudwatch:namespace': 'bedrock-agentcore' },
        },
      }),
    );

    // Secrets Manager — read channel credentials (feishu, etc.) for MCP tool config
    this.agentBaseRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SecretsManagerRead',
        effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:nanoclawbot/${stage}/*`,
        ],
      }),
    );

    // Trust policy: allow AgentBaseRole to AssumeRole + TagSession (for ABAC)
    this.agentScopedRole.assumeRolePolicy?.addStatements(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [new iam.ArnPrincipal(this.agentBaseRole.roleArn)],
        actions: ['sts:TagSession'],
      }),
    );

    // ── Scoped Role: S3 ABAC ───────────────────────────────────────────
    this.agentScopedRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'S3BotData',
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        resources: [
          `${dataBucket.bucketArn}/\${aws:PrincipalTag/userId}/\${aws:PrincipalTag/botId}/*`,
        ],
      }),
    );

    this.agentScopedRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'S3ListBucket',
        effect: iam.Effect.ALLOW,
        actions: ['s3:ListBucket'],
        resources: [dataBucket.bucketArn],
        // Temporarily removed prefix condition to isolate ABAC tag issue
      }),
    );

    this.agentScopedRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'S3SharedData',
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        resources: [
          `${dataBucket.bucketArn}/\${aws:PrincipalTag/userId}/shared/*`,
        ],
      }),
    );

    // Read-only access to global skills library (not ABAC-scoped — skills are platform-level)
    this.agentScopedRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'S3ReadSkills',
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetObject'],
        resources: [`${dataBucket.bucketArn}/skills/*`],
      }),
    );

    // ── Scoped Role: DynamoDB ABAC ─────────────────────────────────────
    const allTableArns = Object.values(tables).map((t) => t.tableArn);
    this.agentScopedRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DynamoDbBotScoped',
        effect: iam.Effect.ALLOW,
        actions: [
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
          'dynamodb:DeleteItem',
          'dynamodb:Query',
        ],
        resources: allTableArns,
        conditions: {
          'ForAllValues:StringLike': {
            'dynamodb:LeadingKeys': ['${aws:PrincipalTag/botId}*'],
          },
        },
      }),
    );

    // ── Scoped Role: EventBridge Scheduler ─────────────────────────────
    this.agentScopedRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SchedulerManage',
        effect: iam.Effect.ALLOW,
        actions: [
          'scheduler:CreateSchedule',
          'scheduler:UpdateSchedule',
          'scheduler:DeleteSchedule',
          'scheduler:GetSchedule',
        ],
        resources: [
          `arn:aws:scheduler:${this.region}:${this.account}:schedule/default/nanoclawbot-*`,
        ],
      }),
    );

    // iam:PassRole for Scheduler — required to assign SchedulerRole to EventBridge schedules
    this.agentScopedRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PassSchedulerRole',
        effect: iam.Effect.ALLOW,
        actions: ['iam:PassRole'],
        resources: [`arn:aws:iam::${this.account}:role/NanoClawBotSchedulerRole-${stage}`],
      }),
    );

    // ── Scheduler Execution Role ────────────────────────────────────────
    this.schedulerRole = new iam.Role(this, 'SchedulerRole', {
      roleName: `NanoClawBotSchedulerRole-${stage}`,
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });

    this.schedulerRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SqsSendMessage',
        effect: iam.Effect.ALLOW,
        actions: ['sqs:SendMessage'],
        resources: [messageQueue.queueArn],
      }),
    );

    // ── Stack Outputs ────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'AgentBaseRoleArn', {
      value: this.agentBaseRole.roleArn,
      exportName: `nanoclawbot-${stage}-agent-base-role-arn`,
    });

    new cdk.CfnOutput(this, 'AgentScopedRoleArn', {
      value: this.agentScopedRole.roleArn,
      exportName: `nanoclawbot-${stage}-agent-scoped-role-arn`,
    });

    new cdk.CfnOutput(this, 'SchedulerRoleArn', {
      value: this.schedulerRole.roleArn,
      exportName: `nanoclawbot-${stage}-scheduler-role-arn`,
    });
  }
}
