import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';

export interface AgentStackProps extends cdk.StackProps {
  stage: string;
  mode: 'agentcore' | 'ecs';
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
  vpc?: ec2.IVpc;
  ecrRepo?: ecr.IRepository;
  minWarmTasks?: number;
  idleTimeoutMinutes?: number;
}

export class AgentStack extends cdk.Stack {
  public readonly agentBaseRole: iam.Role;
  public readonly agentScopedRole: iam.Role;
  public readonly schedulerRole: iam.Role;
  public readonly agentEndpoint: string;

  constructor(scope: Construct, id: string, props: AgentStackProps) {
    super(scope, id, props);

    const { stage, mode, dataBucket, messageQueue, replyQueue, tables } = props;

    // ── Agent Base Role ─────────────────────────────────────────────────
    // Trust principal differs by mode
    const trustPrincipal = mode === 'ecs'
      ? new iam.ServicePrincipal('ecs-tasks.amazonaws.com')
      : new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com');

    this.agentBaseRole = new iam.Role(this, 'AgentBaseRole', {
      roleName: `NanoClawBotAgentBaseRole-${stage}`,
      assumedBy: trustPrincipal,
    });

    // ── Agent Scoped Role (only assumable by base role, NOT by ecs-tasks) ─
    this.agentScopedRole = new iam.Role(this, 'AgentScopedRole', {
      roleName: `NanoClawBotAgentScopedRole-${stage}`,
      assumedBy: new iam.ArnPrincipal(this.agentBaseRole.roleArn),
    });

    // ── Base Role Policies (both modes) ─────────────────────────────────

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

    // Secrets Manager — read channel credentials (feishu, etc.) for MCP tool config
    this.agentBaseRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SecretsManagerRead',
        effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          `arn:${this.partition}:secretsmanager:${this.region}:${this.account}:secret:nanoclawbot/${stage}/*`,
        ],
      }),
    );

    // ── AgentCore-only policies ─────────────────────────────────────────
    if (mode === 'agentcore') {
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
          resources: [`arn:${this.partition}:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*`],
        }),
      );
      this.agentBaseRole.addToPolicy(
        new iam.PolicyStatement({
          sid: 'CloudWatchLogsDescribe',
          effect: iam.Effect.ALLOW,
          actions: ['logs:DescribeLogGroups'],
          resources: [`arn:${this.partition}:logs:${this.region}:${this.account}:log-group:*`],
        }),
      );
      this.agentBaseRole.addToPolicy(
        new iam.PolicyStatement({
          sid: 'CloudWatchLogsPut',
          effect: iam.Effect.ALLOW,
          actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
          resources: [`arn:${this.partition}:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*`],
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
    }

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
          `arn:${this.partition}:scheduler:${this.region}:${this.account}:schedule/default/nanoclawbot-*`,
        ],
      }),
    );

    // iam:PassRole for Scheduler — required to assign SchedulerRole to EventBridge schedules
    this.agentScopedRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PassSchedulerRole',
        effect: iam.Effect.ALLOW,
        actions: ['iam:PassRole'],
        resources: [`arn:${this.partition}:iam::${this.account}:role/NanoClawBotSchedulerRole-${stage}`],
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

    // ── ECS Agent Service (ecs mode only) ───────────────────────────────
    if (mode === 'ecs') {
      const vpc = props.vpc!;

      const agentRepo = ecr.Repository.fromRepositoryName(this, 'AgentRepo', 'nanoclawbot-agent');

      const cluster = new ecs.Cluster(this, 'AgentCluster', {
        clusterName: `nanoclawbot-${stage}-agent`,
        vpc,
      });

      const logGroup = new logs.LogGroup(this, 'AgentLogGroup', {
        logGroupName: `/nanoclawbot/${stage}/agent-runtime`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

      const agentTaskDef = new ecs.FargateTaskDefinition(this, 'AgentTaskDef', {
        cpu: 512,
        memoryLimitMiB: 1024,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.ARM64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
        taskRole: this.agentBaseRole,
      });

      agentTaskDef.addContainer('AgentRuntime', {
        image: ecs.ContainerImage.fromEcrRepository(agentRepo),
        portMappings: [{ containerPort: 8080 }],
        environment: {
          STAGE: stage,
          AWS_REGION: this.region,
          PORT: '8080',
          AGENT_MODE: 'ecs',
          IDLE_TIMEOUT_MINUTES: String(props.idleTimeoutMinutes ?? 60),
          SCOPED_ROLE_ARN: this.agentScopedRole.roleArn,
          SESSION_BUCKET: dataBucket.bucketName,
          SESSIONS_TABLE: tables.sessions.tableName,
          SQS_REPLIES_URL: replyQueue.queueUrl,
          TABLE_TASKS: tables.tasks.tableName,
          SCHEDULER_ROLE_ARN: this.schedulerRole.roleArn,
          SQS_MESSAGES_ARN: messageQueue.queueArn,
        },
        logging: ecs.LogDrivers.awsLogs({
          logGroup,
          streamPrefix: 'ecs',
        }),
      });

      const agentSg = new ec2.SecurityGroup(this, 'AgentSg', {
        vpc,
        description: 'Agent runtime security group',
        allowAllOutbound: true,
      });
      agentSg.addIngressRule(
        ec2.Peer.ipv4(vpc.vpcCidrBlock),
        ec2.Port.tcp(8080),
        'Allow from VPC on port 8080',
      );

      // No ALB — control-plane routes directly to task IPs via DynamoDB registry
      this.agentEndpoint = '';

      // Export infrastructure for control-plane RunTask calls
      new cdk.CfnOutput(this, 'AgentClusterName', {
        value: cluster.clusterName,
        exportName: `nanoclawbot-${stage}-agent-cluster`,
      });
      new cdk.CfnOutput(this, 'AgentTaskDefArn', {
        value: agentTaskDef.taskDefinitionArn,
        exportName: `nanoclawbot-${stage}-agent-task-def`,
      });
      new cdk.CfnOutput(this, 'AgentSubnets', {
        value: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds.join(','),
        exportName: `nanoclawbot-${stage}-agent-subnets`,
      });
      new cdk.CfnOutput(this, 'AgentSecurityGroup', {
        value: agentSg.securityGroupId,
        exportName: `nanoclawbot-${stage}-agent-sg`,
      });
    } else {
      this.agentEndpoint = '';
    }

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
