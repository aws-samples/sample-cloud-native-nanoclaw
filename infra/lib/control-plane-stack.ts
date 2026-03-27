import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';

export interface ControlPlaneStackProps extends cdk.StackProps {
  stage: string;
  vpc: ec2.IVpc;
  dataBucket: s3.IBucket;
  ecrRepo: ecr.IRepository;
  messageQueue: sqs.IQueue;
  replyQueue: sqs.IQueue;
  dlq: sqs.IQueue;
  tables: {
    users: dynamodb.ITable;
    bots: dynamodb.ITable;
    channels: dynamodb.ITable;
    groups: dynamodb.ITable;
    messages: dynamodb.ITable;
    tasks: dynamodb.ITable;
    sessions: dynamodb.ITable;
    providers: dynamodb.ITable;
    skills: dynamodb.ITable;
  };
  userPool: cognito.IUserPool;
  userPoolClient: cognito.IUserPoolClient;
  agentBaseRole: iam.IRole;
  schedulerRoleArn: string;
  messageQueueArn: string;
}

export class ControlPlaneStack extends cdk.Stack {
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly service: ecs.FargateService;
  public readonly cluster: ecs.Cluster;
  /** Shared secret for X-Origin-Verify header between CloudFront and ALB */
  public readonly originVerifySecret: string;

  constructor(scope: Construct, id: string, props: ControlPlaneStackProps) {
    super(scope, id, props);

    const {
      stage,
      vpc,
      dataBucket,
      ecrRepo,
      messageQueue,
      replyQueue,
      dlq,
      tables,
      userPool,
      userPoolClient,
    } = props;

    // SEC-C05: Generate a random origin verification secret, persisted in Secrets Manager.
    // This secret is shared between CloudFront (custom origin header) and ECS (env var).
    const originSecret = new secretsmanager.Secret(this, 'OriginVerifySecret', {
      secretName: `nanoclawbot-${stage}-origin-verify`,
      description: 'Shared secret for X-Origin-Verify header between CloudFront and ALB',
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 32,
      },
    });
    this.originVerifySecret = originSecret.secretValue.unsafeUnwrap();

    // ── Security Groups ─────────────────────────────────────────────────
    const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc,
      description: 'ALB security group',
      allowAllOutbound: true,
    });
    // SEC-C05: ALB accepts HTTP from any IP, but the app-layer X-Origin-Verify
    // header check ensures only CloudFront traffic is processed.
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP from anywhere (origin-verified at app layer)');

    const fargateSg = new ec2.SecurityGroup(this, 'FargateSg', {
      vpc,
      description: 'Fargate tasks security group',
      allowAllOutbound: true,
    });
    fargateSg.addIngressRule(albSg, ec2.Port.tcp(3000), 'From ALB on port 3000');

    // ── ALB ─────────────────────────────────────────────────────────────
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      loadBalancerName: `nanoclawbot-${stage}-alb`,
      vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: albSg,
    });

    // ── ECS Cluster ─────────────────────────────────────────────────────
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: `nanoclawbot-${stage}`,
      vpc,
    });

    // ── Log Group ───────────────────────────────────────────────────────
    const logGroup = new logs.LogGroup(this, 'ControlPlaneLogGroup', {
      logGroupName: `/nanoclawbot/${stage}/control-plane`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── Task Definition ─────────────────────────────────────────────────
    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    // ECR repository for control-plane image
    const controlPlaneRepo = ecr.Repository.fromRepositoryName(
      this,
      'ControlPlaneRepo',
      'nanoclawbot-control-plane',
    );

    taskDef.addContainer('ControlPlane', {
      image: ecs.ContainerImage.fromEcrRepository(controlPlaneRepo),
      portMappings: [{ containerPort: 3000 }],
      environment: {
        STAGE: stage,
        AWS_REGION: this.region,
        USERS_TABLE: tables.users.tableName,
        BOTS_TABLE: tables.bots.tableName,
        CHANNELS_TABLE: tables.channels.tableName,
        GROUPS_TABLE: tables.groups.tableName,
        MESSAGES_TABLE: tables.messages.tableName,
        TASKS_TABLE: tables.tasks.tableName,
        SESSIONS_TABLE: tables.sessions.tableName,
        PROVIDERS_TABLE: tables.providers.tableName,
        SKILLS_TABLE: tables.skills.tableName,
        MESSAGE_QUEUE_URL: messageQueue.queueUrl,
        REPLY_QUEUE_URL: replyQueue.queueUrl,
        DATA_BUCKET: dataBucket.bucketName,
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
        SCHEDULER_ROLE_ARN: props.schedulerRoleArn,
        MESSAGE_QUEUE_ARN: props.messageQueueArn,
        WEBHOOK_BASE_URL_SSM: `/nanoclawbot/${stage}/webhook-base-url`,
        AGENTCORE_RUNTIME_ARN_SSM: `/nanoclawbot/${stage}/agentcore-runtime-arn`,
        ORIGIN_VERIFY_SECRET: this.originVerifySecret,
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: 'ecs',
      }),
    });

    // ── Task Role Permissions ───────────────────────────────────────────
    const taskRole = taskDef.taskRole;

    // DynamoDB CRUD on all tables
    const allTables = Object.values(tables);
    for (const table of allTables) {
      table.grantReadWriteData(taskRole);
    }

    // SQS read/write on message queue and reply queue
    messageQueue.grantSendMessages(taskRole);
    messageQueue.grantConsumeMessages(taskRole);
    replyQueue.grantSendMessages(taskRole);
    replyQueue.grantConsumeMessages(taskRole);

    // S3 read/write on data bucket
    dataBucket.grantReadWrite(taskRole);

    // SSM Parameter Store — read runtime config (webhook URL, AgentCore ARN)
    taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'SsmReadConfig',
        effect: iam.Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/nanoclawbot/${stage}/*`],
      }),
    );

    // Secrets Manager — CRUD for channel credentials
    taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'SecretsManagerAccess',
        effect: iam.Effect.ALLOW,
        actions: [
          'secretsmanager:CreateSecret',
          'secretsmanager:GetSecretValue',
          'secretsmanager:PutSecretValue',
          'secretsmanager:DeleteSecret',
          'secretsmanager:UpdateSecret',
        ],
        resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:nanoclawbot/${stage}/*`],
      }),
    );

    // AgentCore — invoke agent runtime
    taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'AgentCoreInvoke',
        effect: iam.Effect.ALLOW,
        actions: ['bedrock-agentcore:InvokeAgentRuntime'],
        resources: [`arn:aws:bedrock-agentcore:${this.region}:${this.account}:runtime/nanoclawbot_${stage}-*`],
      }),
    );

    // EventBridge Scheduler — manage schedules for scheduled tasks API
    taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'SchedulerManage',
        effect: iam.Effect.ALLOW,
        actions: [
          'scheduler:CreateSchedule',
          'scheduler:GetSchedule',
          'scheduler:UpdateSchedule',
          'scheduler:DeleteSchedule',
        ],
        resources: [`arn:aws:scheduler:${this.region}:${this.account}:schedule/default/nanoclawbot-*`],
      }),
    );
    taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'PassSchedulerRole',
        effect: iam.Effect.ALLOW,
        actions: ['iam:PassRole'],
        resources: [props.schedulerRoleArn],
      }),
    );

    // ECS RunTask (scoped to this cluster's tasks)
    taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'EcsRunTask',
        effect: iam.Effect.ALLOW,
        actions: ['ecs:RunTask', 'ecs:DescribeTasks', 'ecs:StopTask'],
        resources: [
          `arn:aws:ecs:${this.region}:${this.account}:task/${this.cluster.clusterName}/*`,
          `arn:aws:ecs:${this.region}:${this.account}:task-definition/nanoclawbot-${stage}-*`,
        ],
      }),
    );

    // Pass role for agent tasks
    taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'PassAgentRole',
        effect: iam.Effect.ALLOW,
        actions: ['iam:PassRole'],
        resources: [props.agentBaseRole.roleArn, taskDef.executionRole!.roleArn],
      }),
    );

    // Cognito — admin user management (create, enable, disable)
    taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'CognitoAdminUser',
        effect: iam.Effect.ALLOW,
        actions: [
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminDisableUser',
          'cognito-idp:AdminEnableUser',
        ],
        resources: [props.userPool.userPoolArn],
      }),
    );

    // ── Fargate Service ─────────────────────────────────────────────────
    this.service = new ecs.FargateService(this, 'Service', {
      cluster: this.cluster,
      taskDefinition: taskDef,
      desiredCount: 2,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [fargateSg],
    });

    // ── ECS Auto-Scaling ───────────────────────────────────────────────
    const scaling = this.service.autoScaleTaskCount({
      minCapacity: 2,
      maxCapacity: 10,
    });

    const queueMessagesVisible = new cloudwatch.Metric({
      namespace: 'AWS/SQS',
      metricName: 'ApproximateNumberOfMessagesVisible',
      dimensionsMap: {
        QueueName: messageQueue.queueName,
      },
      statistic: 'Average',
      period: cdk.Duration.minutes(1),
    });

    // Scale up: +1 at 50 messages, +2 at 200 messages
    scaling.scaleOnMetric('ScaleUp', {
      metric: queueMessagesVisible,
      scalingSteps: [
        { upper: 50, change: 0 },
        { lower: 50, change: +1 },
        { lower: 200, change: +2 },
      ],
      adjustmentType: cdk.aws_applicationautoscaling.AdjustmentType.CHANGE_IN_CAPACITY,
      cooldown: cdk.Duration.minutes(3),
    });

    // Scale down: -1 when 0 messages
    scaling.scaleOnMetric('ScaleDown', {
      metric: queueMessagesVisible,
      scalingSteps: [
        { upper: 0, change: 0 },
        { lower: 0, change: -1 },
      ],
      adjustmentType: cdk.aws_applicationautoscaling.AdjustmentType.CHANGE_IN_CAPACITY,
      cooldown: cdk.Duration.minutes(30),
    });

    // ── ALB Target Group & Listener ─────────────────────────────────────
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [this.service],
      healthCheck: {
        path: '/health',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    this.alb.addListener('HttpListener', {
      port: 80,
      defaultTargetGroups: [targetGroup],
    });

    // ── WAF WebACL ──────────────────────────────────────────────────────
    const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      name: `nanoclawbot-${stage}-waf`,
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `nanoclawbot-${stage}-waf`,
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: 'RateLimit',
          priority: 1,
          action: { block: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `nanoclawbot-${stage}-rate-limit`,
            sampledRequestsEnabled: true,
          },
          statement: {
            rateBasedStatement: {
              limit: 2000,
              aggregateKeyType: 'IP',
            },
          },
        },
      ],
    });

    new wafv2.CfnWebACLAssociation(this, 'WebAclAssociation', {
      resourceArn: this.alb.loadBalancerArn,
      webAclArn: webAcl.attrArn,
    });

    // ── Outputs ─────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: this.alb.loadBalancerDnsName,
      exportName: `nanoclawbot-${stage}-alb-dns`,
    });
  }
}
