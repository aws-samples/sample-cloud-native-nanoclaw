[← 返回架构总览](../CLOUD_ARCHITECTURE.md)

## 15. CDK 部署架构

### 15.1 项目结构

```
infra/
├── bin/
│   └── clawbot.ts                  # CDK App 入口
├── lib/
│   ├── stacks/
│   │   ├── foundation-stack.ts     # VPC, ECR, S3, DynamoDB
│   │   ├── auth-stack.ts           # Cognito User Pool
│   │   ├── control-plane-stack.ts  # ALB + ECS Fargate Service
│   │   ├── agent-stack.ts          # AgentCore Runtime (Custom Resource)
│   │   ├── frontend-stack.ts       # CloudFront + S3 (SPA)
│   │   └── monitoring-stack.ts     # CloudWatch Dashboards, Alarms
│   ├── constructs/
│   │   ├── dynamodb-tables.ts      # 所有 DynamoDB 表定义
│   │   ├── sqs-queues.ts           # SQS FIFO + DLQ
│   │   ├── agentcore-runtime.ts    # AgentCore Custom Resource
│   │   └── waf-rules.ts           # WAF ACL
│   └── config.ts                   # 环境配置 (dev/staging/prod)
├── cdk.json
├── tsconfig.json
└── package.json
```

### 15.2 Stack 依赖关系

```
FoundationStack (VPC, S3, DynamoDB, ECR, SQS)
    │
    ├──→ AuthStack (Cognito)
    │
    ├──→ ControlPlaneStack (ALB + Fargate)
    │       依赖: Foundation, Auth
    │
    ├──→ AgentStack (AgentCore Runtime)
    │       依赖: Foundation
    │
    ├──→ FrontendStack (CloudFront + S3)
    │       依赖: Auth, ControlPlane (ALB domain)
    │
    └──→ MonitoringStack (Dashboards, Alarms)
            依赖: All
```

### 15.3 Foundation Stack

```typescript
// lib/stacks/foundation-stack.ts

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { DynamoDbTables } from '../constructs/dynamodb-tables';
import { Construct } from 'constructs';

export class FoundationStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly dataBucket: s3.Bucket;
  public readonly agentRepo: ecr.Repository;
  public readonly controlPlaneRepo: ecr.Repository;
  public readonly tables: DynamoDbTables;
  public readonly messageQueue: sqs.Queue;
  public readonly replyQueue: sqs.Queue;
  public readonly taskQueue: sqs.Queue;
  public readonly deadLetterQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── VPC ──
    this.vpc = new ec2.Vpc(this, 'ClawBotVpc', {
      maxAzs: 2,
      natGateways: 1,  // Fargate 需要 NAT 访问外网
      subnetConfiguration: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC },
        { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      ],
    });

    // ── S3: 数据存储 ──
    this.dataBucket = new s3.Bucket(this, 'DataBucket', {
      bucketName: `clawbot-data-${this.account}-${this.region}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      lifecycleRules: [
        {
          // Session 文件 90 天后转 Infrequent Access
          prefix: '*/sessions/',
          transitions: [
            { storageClass: s3.StorageClass.INFREQUENT_ACCESS, transitionAfter: cdk.Duration.days(90) },
          ],
        },
        {
          // 对话归档 180 天后转 Glacier
          prefix: '*/archives/',
          transitions: [
            { storageClass: s3.StorageClass.GLACIER, transitionAfter: cdk.Duration.days(180) },
          ],
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── ECR: 容器镜像仓库 ──
    this.agentRepo = new ecr.Repository(this, 'AgentRepo', {
      repositoryName: 'clawbot-agent',
      lifecycleRules: [{ maxImageCount: 10 }],  // 保留最近 10 个镜像
    });

    this.controlPlaneRepo = new ecr.Repository(this, 'ControlPlaneRepo', {
      repositoryName: 'clawbot-control-plane',
      lifecycleRules: [{ maxImageCount: 10 }],
    });

    // ── SQS: 消息队列 ──
    this.deadLetterQueue = new sqs.Queue(this, 'DLQ', {
      queueName: 'clawbot-dlq.fifo',
      fifo: true,
      retentionPeriod: cdk.Duration.days(14),
    });

    this.messageQueue = new sqs.Queue(this, 'MessageQueue', {
      queueName: 'clawbot-messages.fifo',
      fifo: true,
      fifoThroughputLimit: sqs.FifoThroughputLimit.PER_MESSAGE_GROUP_ID,  // 高吞吐模式
      deduplicationScope: sqs.DeduplicationScope.MESSAGE_GROUP,           // 配合高吞吐
      contentBasedDeduplication: true,
      visibilityTimeout: cdk.Duration.minutes(10),
      deadLetterQueue: {
        queue: this.deadLetterQueue,
        maxReceiveCount: 3,
      },
    });
    // 高吞吐 FIFO: 每个 MessageGroupId 独立 300 msg/s 限额,
    // 整体队列吞吐 = 300 × 活跃 MessageGroupId 数, 无全局瓶颈。
    // 标准 FIFO 模式下整个队列共享 300 msg/s, 不适合多租户。

    // Agent → Control Plane 的回复队列 (标准队列, 不需要 FIFO)
    this.replyQueue = new sqs.Queue(this, 'ReplyQueue', {
      queueName: 'clawbot-replies',
      visibilityTimeout: cdk.Duration.seconds(30),
    });

    // EventBridge Scheduler → Fargate 的任务队列
    this.taskQueue = new sqs.Queue(this, 'TaskQueue', {
      queueName: 'clawbot-tasks.fifo',
      fifo: true,
      fifoThroughputLimit: sqs.FifoThroughputLimit.PER_MESSAGE_GROUP_ID,
      deduplicationScope: sqs.DeduplicationScope.MESSAGE_GROUP,
      contentBasedDeduplication: true,
      visibilityTimeout: cdk.Duration.minutes(10),
      deadLetterQueue: {
        queue: this.deadLetterQueue,
        maxReceiveCount: 3,
      },
    });

    // ── DynamoDB: 所有表 ──
    this.tables = new DynamoDbTables(this, 'Tables');
  }
}
```

### 15.4 DynamoDB 表定义

```typescript
// lib/constructs/dynamodb-tables.ts

import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export class DynamoDbTables extends Construct {
  public readonly users: dynamodb.Table;
  public readonly bots: dynamodb.Table;
  public readonly channels: dynamodb.Table;
  public readonly groups: dynamodb.Table;
  public readonly messages: dynamodb.Table;
  public readonly tasks: dynamodb.Table;
  public readonly sessions: dynamodb.Table;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.users = new dynamodb.Table(this, 'Users', {
      tableName: 'clawbot-users',
      partitionKey: { name: 'user_id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      // 属性: email, display_name, plan, quota (JSON),
      //       usage_month, usage_tokens, usage_invocations, active_agents
    });

    this.bots = new dynamodb.Table(this, 'Bots', {
      tableName: 'clawbot-bots',
      partitionKey: { name: 'user_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'bot_id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    // GSI: 通过 bot_id 查找 (Webhook 路由用)
    this.bots.addGlobalSecondaryIndex({
      indexName: 'bot-id-index',
      partitionKey: { name: 'bot_id', type: dynamodb.AttributeType.STRING },
    });

    this.channels = new dynamodb.Table(this, 'Channels', {
      tableName: 'clawbot-channels',
      partitionKey: { name: 'bot_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'channel_key', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    this.groups = new dynamodb.Table(this, 'Groups', {
      tableName: 'clawbot-groups',
      partitionKey: { name: 'bot_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'group_jid', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    this.messages = new dynamodb.Table(this, 'Messages', {
      tableName: 'clawbot-messages',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },  // {bot_id}#{group_jid}
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',  // 90 天自动过期 (created_at + 7,776,000s)
      // 热分区缓解: 按需模式自适应分裂，单分区 1,000 WCU/s
      // 查询优化: ScanIndexForward=false + Limit=50 取最近消息
    });

    this.tasks = new dynamodb.Table(this, 'Tasks', {
      tableName: 'clawbot-tasks',
      partitionKey: { name: 'bot_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    this.sessions = new dynamodb.Table(this, 'Sessions', {
      tableName: 'clawbot-sessions',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },  // {bot_id}#{group_jid}
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },       // "current"
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });
  }
}
```

### 15.5 Auth Stack

```typescript
// lib/stacks/auth-stack.ts

import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

export class AuthStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly userPoolDomain: cognito.UserPoolDomain;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'clawbot-users',
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 8,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.userPoolClient = this.userPool.addClient('WebClient', {
      authFlows: {
        userSrp: true,
        userPassword: false,  // 禁止明文密码认证
      },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: ['https://app.clawbot.com/callback', 'http://localhost:3000/callback'],
        logoutUrls: ['https://app.clawbot.com', 'http://localhost:3000'],
      },
      idTokenValidity: cdk.Duration.hours(1),
      accessTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
    });

    this.userPoolDomain = this.userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: 'clawbot' },
    });
  }
}
```

### 15.6 Control Plane Stack

```typescript
// lib/stacks/control-plane-stack.ts

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import { FoundationStack } from './foundation-stack';
import { AuthStack } from './auth-stack';

interface ControlPlaneProps extends cdk.StackProps {
  foundation: FoundationStack;
  auth: AuthStack;
  domainName: string;           // e.g. "api.clawbot.com"
  certificateArn: string;       // ACM 证书 ARN
  agentRuntimeArn: string;      // AgentCore Runtime ARN
}

export class ControlPlaneStack extends cdk.Stack {
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly service: ecs.FargateService;

  constructor(scope: Construct, id: string, props: ControlPlaneProps) {
    super(scope, id, props);

    const { foundation, auth } = props;

    // ── ECS Cluster ──
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: foundation.vpc,
      clusterName: 'clawbot',
      containerInsights: true,
    });

    // ── Task Role (Control Plane 进程的权限) ──
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // DynamoDB 全表访问
    foundation.tables.users.grantReadWriteData(taskRole);
    foundation.tables.bots.grantReadWriteData(taskRole);
    foundation.tables.channels.grantReadWriteData(taskRole);
    foundation.tables.groups.grantReadWriteData(taskRole);
    foundation.tables.messages.grantReadWriteData(taskRole);
    foundation.tables.tasks.grantReadWriteData(taskRole);
    foundation.tables.sessions.grantReadWriteData(taskRole);

    // SQS 读写
    foundation.messageQueue.grantSendMessages(taskRole);
    foundation.messageQueue.grantConsumeMessages(taskRole);
    foundation.replyQueue.grantConsumeMessages(taskRole);
    foundation.taskQueue.grantConsumeMessages(taskRole);

    // S3 读写
    foundation.dataBucket.grantReadWrite(taskRole);

    // Secrets Manager (Channel 凭证)
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'secretsmanager:GetSecretValue',
        'secretsmanager:CreateSecret',
        'secretsmanager:UpdateSecret',
        'secretsmanager:DeleteSecret',
      ],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:clawbot/*`],
    }));

    // AgentCore Runtime 调用
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:InvokeAgentRuntime'],
      resources: [props.agentRuntimeArn],
    }));

    // EventBridge Scheduler 管理
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'scheduler:CreateSchedule', 'scheduler:UpdateSchedule',
        'scheduler:DeleteSchedule', 'scheduler:GetSchedule',
      ],
      resources: [`arn:aws:scheduler:${this.region}:${this.account}:schedule/default/clawbot-*`],
    }));
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [`arn:aws:iam::${this.account}:role/ClawBotSchedulerRole`],
    }));

    // ── Task Definition ──
    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: 512,       // 0.5 vCPU
      memoryLimitMiB: 1024,   // 1 GB
      taskRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const container = taskDef.addContainer('ControlPlane', {
      image: ecs.ContainerImage.fromEcrRepository(foundation.controlPlaneRepo, 'latest'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'control-plane',
        logRetention: logs.RetentionDays.ONE_MONTH,
      }),
      environment: {
        NODE_ENV: 'production',
        AWS_REGION: this.region,
        COGNITO_USER_POOL_ID: auth.userPool.userPoolId,
        COGNITO_CLIENT_ID: auth.userPoolClient.userPoolClientId,
        MESSAGE_QUEUE_URL: foundation.messageQueue.queueUrl,
        REPLY_QUEUE_URL: foundation.replyQueue.queueUrl,
        TASK_QUEUE_URL: foundation.taskQueue.queueUrl,
        DATA_BUCKET: foundation.dataBucket.bucketName,
        AGENTCORE_RUNTIME_ARN: props.agentRuntimeArn,
        DYNAMODB_TABLE_PREFIX: 'clawbot-',
      },
      portMappings: [{ containerPort: 8080 }],
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost:8080/health || exit 1'],
        interval: cdk.Duration.seconds(15),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
      },
    });

    // ── ALB ──
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'ALB', {
      vpc: foundation.vpc,
      internetFacing: true,
      loadBalancerName: 'clawbot-alb',
    });

    const certificate = acm.Certificate.fromCertificateArn(this, 'Cert', props.certificateArn);

    const httpsListener = this.alb.addListener('HTTPS', {
      port: 443,
      certificates: [certificate],
      protocol: elbv2.ApplicationProtocol.HTTPS,
    });

    // HTTP → HTTPS 重定向
    this.alb.addListener('HTTP', {
      port: 80,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS', port: '443', permanent: true,
      }),
    });

    // ── Fargate Service ──
    this.service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 2,     // 高可用最少 2 个 Task
      minHealthyPercent: 50,
      maxHealthyPercent: 200,
      serviceName: 'clawbot-control-plane',
      assignPublicIp: false,  // 在 Private Subnet，通过 NAT 访问外网
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      capacityProviderStrategies: [
        { capacityProvider: 'FARGATE', weight: 1, base: 2 },        // 基础 2 个用 On-Demand
        { capacityProvider: 'FARGATE_SPOT', weight: 3 },             // 扩容用 Spot (省 70%)
      ],
    });

    httpsListener.addTargets('ControlPlane', {
      port: 8080,
      targets: [this.service],
      healthCheck: {
        path: '/health',
        interval: cdk.Duration.seconds(15),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // ── Auto Scaling ──
    const scaling = this.service.autoScaleTaskCount({
      minCapacity: 2,
      maxCapacity: 10,
    });

    // 基于 SQS 队列深度扩缩
    scaling.scaleOnMetric('QueueDepthScaling', {
      metric: foundation.messageQueue.metricApproximateNumberOfMessagesVisible(),
      scalingSteps: [
        { upper: 0, change: 0 },     // 0 条消息 → 维持当前
        { lower: 50, change: +2 },   // 50+ → 加 2 个 Task
        { lower: 200, change: +4 },  // 200+ → 加 4 个 Task
      ],
      cooldown: cdk.Duration.minutes(3),
    });

    // 基于 CPU 使用率扩缩
    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.minutes(5),
      scaleOutCooldown: cdk.Duration.minutes(2),
    });

    // ── WAF ──
    const waf = new wafv2.CfnWebACL(this, 'WAF', {
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: 'clawbot-waf',
      },
      rules: [
        {
          name: 'RateLimit',
          priority: 1,
          action: { block: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'clawbot-rate-limit',
          },
          statement: {
            rateBasedStatement: {
              limit: 2000,  // 5 分钟内 2000 请求
              aggregateKeyType: 'IP',
            },
          },
        },
        {
          name: 'AWSManagedRulesCommonRuleSet',
          priority: 2,
          overrideAction: { none: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'clawbot-common-rules',
          },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
            },
          },
        },
      ],
    });

    new wafv2.CfnWebACLAssociation(this, 'WAFAssociation', {
      resourceArn: this.alb.loadBalancerArn,
      webAclArn: waf.attrArn,
    });
  }
}
```

### 15.7 Agent Stack

AgentCore Runtime 尚无 CDK L2 construct，使用 Custom Resource 封装 boto3 调用。

```typescript
// lib/stacks/agent-stack.ts

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { FoundationStack } from './foundation-stack';

interface AgentStackProps extends cdk.StackProps {
  foundation: FoundationStack;
}

export class AgentStack extends cdk.Stack {
  public readonly agentRuntimeArn: string;
  public readonly agentRole: iam.Role;
  public readonly scopedRole: iam.Role;

  constructor(scope: Construct, id: string, props: AgentStackProps) {
    super(scope, id, props);

    const { foundation } = props;

    // ── 基础 Role (AgentCore 绑定, 无 S3/DynamoDB 权限) ──
    this.agentRole = new iam.Role(this, 'AgentRole', {
      roleName: 'ClawBotAgentRole',
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
    });

    // Bedrock 模型调用
    this.agentRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: ['arn:aws:bedrock:*::foundation-model/anthropic.*'],
    }));

    // SQS 回复队列 (公共通道, 不需要 per-user 隔离)
    foundation.replyQueue.grantSendMessages(this.agentRole);

    // ── Scoped Role (ABAC: Session Tags 限定 per-user/per-bot) ──
    this.scopedRole = new iam.Role(this, 'ScopedRole', {
      roleName: 'ClawBotAgentScopedRole',
      assumedBy: new iam.ArnPrincipal(this.agentRole.roleArn),
    });

    // S3: Bot 数据读写 (通过 Session Tags 限定路径)
    this.scopedRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
      resources: [
        `${foundation.dataBucket.bucketArn}/\${aws:PrincipalTag/userId}/\${aws:PrincipalTag/botId}/*`,
      ],
    }));

    // S3: 用户共享记忆只读 (跨 Bot 共享知识)
    this.scopedRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [
        `${foundation.dataBucket.bucketArn}/\${aws:PrincipalTag/userId}/shared/*`,
      ],
    }));

    // S3: ListBucket (限定前缀)
    this.scopedRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [foundation.dataBucket.bucketArn],
      conditions: {
        StringLike: {
          's3:prefix': [
            '${aws:PrincipalTag/userId}/${aws:PrincipalTag/botId}/*',
            '${aws:PrincipalTag/userId}/shared/*',
          ],
        },
      },
    }));

    // DynamoDB: 通过 LeadingKeys 限定 botId
    this.scopedRole.addToPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem',
                'dynamodb:DeleteItem', 'dynamodb:Query'],
      resources: [foundation.tables.tasks.tableArn],
      conditions: {
        'ForAllValues:StringEquals': {
          'dynamodb:LeadingKeys': ['${aws:PrincipalTag/botId}'],
        },
      },
    }));

    // EventBridge Scheduler: 资源名限定 botId
    this.scopedRole.addToPolicy(new iam.PolicyStatement({
      actions: ['scheduler:CreateSchedule', 'scheduler:UpdateSchedule',
                'scheduler:DeleteSchedule', 'scheduler:GetSchedule'],
      resources: [
        `arn:aws:scheduler:${this.region}:${this.account}:schedule/default/clawbot-\${aws:PrincipalTag/botId}-*`,
      ],
    }));

    // 基础 Role: 允许 AssumeRole + TagSession 到 Scoped Role
    this.agentRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole', 'sts:TagSession'],
      resources: [this.scopedRole.roleArn],
    }));

    // ── EventBridge Scheduler 执行角色 ──
    const schedulerRole = new iam.Role(this, 'SchedulerRole', {
      roleName: 'ClawBotSchedulerRole',
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });
    foundation.taskQueue.grantSendMessages(schedulerRole);

    // Scheduler 角色需要被 Agent 的 MCP 工具 PassRole
    this.scopedRole.addToPolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [schedulerRole.roleArn],
    }));

    // ── AgentCore Runtime (Custom Resource) ──
    const agentRuntime = new cr.AwsCustomResource(this, 'AgentRuntime', {
      onCreate: {
        service: 'BedrockAgentCoreControl',
        action: 'createAgentRuntime',
        parameters: {
          agentRuntimeName: 'clawbot-agent',
          agentRuntimeArtifact: {
            containerConfiguration: {
              containerUri: `${foundation.agentRepo.repositoryUri}:latest`,
            },
          },
          roleArn: this.agentRole.roleArn,
          networkConfiguration: { networkMode: 'PUBLIC' },
          environmentVariables: {
            CLAUDE_CODE_USE_BEDROCK: '1',
            AWS_REGION: this.region,
            CLAWBOT_S3_BUCKET: foundation.dataBucket.bucketName,
            CLAWBOT_DYNAMODB_TABLE_PREFIX: 'clawbot-',
            CLAWBOT_REPLY_QUEUE_URL: foundation.replyQueue.queueUrl,
            CLAWBOT_TASK_QUEUE_ARN: foundation.taskQueue.queueArn,
            CLAWBOT_SCHEDULER_ROLE_ARN: schedulerRole.roleArn,
            CLAWBOT_SCOPED_ROLE_ARN: this.scopedRole.roleArn,
          },
        },
        physicalResourceId: cr.PhysicalResourceId.fromResponse('agentRuntimeArn'),
      },
      onDelete: {
        service: 'BedrockAgentCoreControl',
        action: 'deleteAgentRuntime',
        parameters: {
          agentRuntimeName: 'clawbot-agent',
        },
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: [
            'bedrock-agentcore:CreateAgentRuntime',
            'bedrock-agentcore:DeleteAgentRuntime',
            'bedrock-agentcore:UpdateAgentRuntime',
          ],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          actions: ['iam:PassRole'],
          resources: [this.agentRole.roleArn],
        }),
      ]),
    });

    this.agentRuntimeArn = agentRuntime.getResponseField('agentRuntimeArn');
  }
}
```

### 15.8 Frontend Stack

```typescript
// lib/stacks/frontend-stack.ts

import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';

interface FrontendStackProps extends cdk.StackProps {
  domainName: string;           // e.g. "app.clawbot.com"
  certificateArn: string;       // us-east-1 ACM 证书 (CloudFront 要求)
  apiDomainName: string;        // e.g. "api.clawbot.com"
}

export class FrontendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);

    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const certificate = acm.Certificate.fromCertificateArn(
      this, 'Cert', props.certificateArn,
    );

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      domainNames: [props.domainName],
      certificate,
      defaultRootObject: 'index.html',
      // SPA: 所有 404 返回 index.html
      errorResponses: [
        {
          httpStatus: 404,
          responsePagePath: '/index.html',
          responseHttpStatus: 200,
          ttl: cdk.Duration.seconds(0),
        },
      ],
    });

    // 部署前端构建产物 (可选, 也可用 CI/CD)
    // new s3deploy.BucketDeployment(this, 'Deploy', {
    //   sources: [s3deploy.Source.asset('../frontend/dist')],
    //   destinationBucket: siteBucket,
    //   distribution,
    // });

    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: distribution.distributionDomainName,
    });
  }
}
```

### 15.9 CDK App 入口

```typescript
// bin/clawbot.ts

import * as cdk from 'aws-cdk-lib';
import { FoundationStack } from '../lib/stacks/foundation-stack';
import { AuthStack } from '../lib/stacks/auth-stack';
import { AgentStack } from '../lib/stacks/agent-stack';
import { ControlPlaneStack } from '../lib/stacks/control-plane-stack';
import { FrontendStack } from '../lib/stacks/frontend-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-west-2',
};

// ── Stack 实例化 (顺序体现依赖关系) ──

const foundation = new FoundationStack(app, 'ClawBot-Foundation', { env });

const auth = new AuthStack(app, 'ClawBot-Auth', { env });

const agent = new AgentStack(app, 'ClawBot-Agent', {
  env,
  foundation,
});

const controlPlane = new ControlPlaneStack(app, 'ClawBot-ControlPlane', {
  env,
  foundation,
  auth,
  domainName: 'api.clawbot.com',
  certificateArn: 'arn:aws:acm:us-west-2:ACCOUNT:certificate/CERT_ID',
  agentRuntimeArn: agent.agentRuntimeArn,
});

const frontend = new FrontendStack(app, 'ClawBot-Frontend', {
  env: { ...env, region: 'us-east-1' },  // CloudFront 证书必须在 us-east-1
  domainName: 'app.clawbot.com',
  certificateArn: 'arn:aws:acm:us-east-1:ACCOUNT:certificate/CERT_ID',
  apiDomainName: 'api.clawbot.com',
});
```

### 15.10 部署流程

**一键部署 (推荐):**

```bash
# 完整部署 (默认 stage=dev)
./scripts/deploy.sh

# 指定环境
CDK_STAGE=prod AWS_REGION=us-east-1 ./scripts/deploy.sh
```

`scripts/deploy.sh` 执行 15 步:

```
Step 1:  预检 (aws sts, docker, node, jq)
Step 2:  npm install && npm run build --workspaces
Step 3:  ECR 登录 (如 repo 不存在则自动创建)
Step 4:  构建 control-plane Docker 镜像 (ARM64) → 推送 ECR
Step 5:  构建 agent-runtime Docker 镜像 (ARM64) → 推送 ECR
Step 6:  CDK deploy 全部 6 个 Stack
Step 7:  读取 Stack 输出 (Cognito ID, Bucket, Role ARN, ALB DNS, CDN 域名)
Step 8:  注册 AgentCore Runtime (幂等: 已存在则跳过)
Step 9:  轮询等待 AgentCore 状态 → READY (每 10s, 最多 10min)
Step 10: 更新 ECS Task Definition, 注入 AGENTCORE_RUNTIME_ARN 环境变量
Step 11: 强制 ECS 滚动部署
Step 12: 注入 Cognito 配置, 构建 web-console
Step 13: aws s3 sync web-console/dist/ → 前端 S3 Bucket
Step 14: CloudFront 缓存失效
Step 15: 冒烟测试 (curl /health)
```

**关键设计:**
- 幂等: AgentCore runtime 已存在时跳过创建
- ECR 仓库不存在时自动 `create-repository`
- 使用 `jq` 安全构建 JSON (避免 shell 变量注入)
- Stack 输出通过 `--outputs-file cdk-outputs.json` 获取

**销毁环境:**

```bash
./scripts/destroy.sh                    # 默认 dev
CDK_STAGE=prod ./scripts/destroy.sh     # 指定环境
```

反向执行: 删除 AgentCore runtime (等待完成) → CDK destroy → 清理 ECR 仓库。

**手动单步更新 (无需全量部署):**

```bash
# 仅更新 Agent 代码
docker build --platform linux/arm64 -t ${ECR_URI}/nanoclawbot-agent:latest -f agent-runtime/Dockerfile .
docker push ${ECR_URI}/nanoclawbot-agent:latest
# AgentCore 新 session 自动拉取 latest

# 仅更新 Control Plane 代码
docker build --platform linux/arm64 -t ${ECR_URI}/nanoclawbot-control-plane:latest -f control-plane/Dockerfile .
docker push ${ECR_URI}/nanoclawbot-control-plane:latest
aws ecs update-service --cluster nanoclawbot-${STAGE} --service ... --force-new-deployment

# 仅更新前端
npm run build -w web-console
aws s3 sync web-console/dist/ s3://${WEBSITE_BUCKET}/ --delete
aws cloudfront create-invalidation --distribution-id ${DIST_ID} --paths "/*"
```

### 15.11 环境管理 (dev / staging / prod)

```typescript
// lib/config.ts

export interface EnvironmentConfig {
  envName: string;
  domainPrefix: string;          // "dev", "staging", ""
  fargateDesiredCount: number;
  fargateMaxCount: number;
  fargateCpu: number;
  fargateMemory: number;
  enableWaf: boolean;
  s3VersioningEnabled: boolean;
  dynamoDbRemovalPolicy: cdk.RemovalPolicy;
}

export const environments: Record<string, EnvironmentConfig> = {
  dev: {
    envName: 'dev',
    domainPrefix: 'dev',               // dev-api.clawbot.com
    fargateDesiredCount: 1,             // 省钱: 1 个 Task
    fargateMaxCount: 2,
    fargateCpu: 256,                    // 0.25 vCPU
    fargateMemory: 512,
    enableWaf: false,
    s3VersioningEnabled: false,
    dynamoDbRemovalPolicy: cdk.RemovalPolicy.DESTROY,
  },
  staging: {
    envName: 'staging',
    domainPrefix: 'staging',
    fargateDesiredCount: 2,
    fargateMaxCount: 4,
    fargateCpu: 512,
    fargateMemory: 1024,
    enableWaf: true,
    s3VersioningEnabled: true,
    dynamoDbRemovalPolicy: cdk.RemovalPolicy.RETAIN,
  },
  prod: {
    envName: 'prod',
    domainPrefix: '',                   // api.clawbot.com
    fargateDesiredCount: 2,
    fargateMaxCount: 10,
    fargateCpu: 512,
    fargateMemory: 1024,
    enableWaf: true,
    s3VersioningEnabled: true,
    dynamoDbRemovalPolicy: cdk.RemovalPolicy.RETAIN,
  },
};
```

### 15.12 CI/CD Pipeline (概要)

```
GitHub Actions / CodePipeline

┌─────────────┐     ┌───────────────┐     ┌──────────────┐
│  git push    │────→│  Build & Test  │────→│  Deploy Dev   │
│  (main)      │     │  (lint, test)  │     │  (auto)       │
└─────────────┘     └───────────────┘     └──────┬───────┘
                                                  │
                                          手动审批 │
                                                  ▼
                                          ┌──────────────┐
                                          │ Deploy Prod   │
                                          │ (cdk deploy)  │
                                          └──────────────┘

步骤:
1. TypeScript 编译 + Vitest 测试
2. Docker build (ARM64) + push ECR
3. cdk diff → cdk deploy (dev)
4. 集成测试 (Webhook 端到端)
5. 手动审批 → cdk deploy (prod)
6. ECS force-new-deployment (Control Plane 滚动更新)
```
