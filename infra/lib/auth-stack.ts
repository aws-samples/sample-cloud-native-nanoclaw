import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

export interface AuthStackProps extends cdk.StackProps {
  stage: string;
  mode: 'agentcore' | 'ecs';
  vpc?: ec2.IVpc;
  ecrRepo?: ecr.IRepository;
}

export class AuthStack extends cdk.Stack {
  public readonly userPool: cognito.IUserPool;
  public readonly userPoolClient: cognito.IUserPoolClient;
  public readonly authEndpoint: string;
  public readonly authJwksUrl: string;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    const { stage, mode } = props;
    const isProd = stage === 'prod';

    if (mode === 'ecs') {
      // ── ECS Auth Service ───────────────────────────────────────────────
      const vpc = props.vpc!;

      const authRepo = ecr.Repository.fromRepositoryName(this, 'AuthRepo', 'nanoclawbot-auth-service');

      const cluster = new ecs.Cluster(this, 'AuthCluster', {
        clusterName: `nanoclawbot-${stage}-auth`,
        vpc,
      });

      const logGroup = new logs.LogGroup(this, 'AuthLogGroup', {
        logGroupName: `/nanoclawbot/${stage}/auth-service`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

      const taskDef = new ecs.FargateTaskDefinition(this, 'AuthTaskDef', {
        cpu: 256,
        memoryLimitMiB: 512,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.ARM64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
      });

      taskDef.addContainer('AuthService', {
        image: ecs.ContainerImage.fromEcrRepository(authRepo),
        portMappings: [{ containerPort: 3001 }],
        environment: {
          STAGE: stage,
          AWS_REGION: this.region,
          USERS_TABLE: `nanoclawbot-${stage}-users`,
          PORT: '3001',
        },
        logging: ecs.LogDrivers.awsLogs({
          logGroup,
          streamPrefix: 'ecs',
        }),
      });

      // Task role permissions: DynamoDB + Secrets Manager
      const taskRole = taskDef.taskRole;
      taskRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          sid: 'DynamoDbUsers',
          effect: iam.Effect.ALLOW,
          actions: [
            'dynamodb:GetItem',
            'dynamodb:PutItem',
            'dynamodb:UpdateItem',
            'dynamodb:DeleteItem',
            'dynamodb:Query',
          ],
          resources: [
            `arn:aws:dynamodb:${this.region}:${this.account}:table/nanoclawbot-${stage}-users`,
            `arn:aws:dynamodb:${this.region}:${this.account}:table/nanoclawbot-${stage}-users/index/*`,
          ],
        }),
      );
      taskRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          sid: 'SecretsManagerRead',
          effect: iam.Effect.ALLOW,
          actions: ['secretsmanager:GetSecretValue'],
          resources: [
            `arn:aws:secretsmanager:${this.region}:${this.account}:secret:nanoclawbot/${stage}/*`,
          ],
        }),
      );

      // Security group
      const authSg = new ec2.SecurityGroup(this, 'AuthSg', {
        vpc,
        description: 'Auth service security group',
        allowAllOutbound: true,
      });
      authSg.addIngressRule(
        ec2.Peer.ipv4(vpc.vpcCidrBlock),
        ec2.Port.tcp(3001),
        'Allow from VPC on port 3001',
      );

      const service = new ecs.FargateService(this, 'AuthService', {
        cluster,
        taskDefinition: taskDef,
        desiredCount: 2,
        assignPublicIp: false,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [authSg],
      });

      // Internal ALB
      const albSg = new ec2.SecurityGroup(this, 'AuthAlbSg', {
        vpc,
        description: 'Auth ALB security group',
        allowAllOutbound: true,
      });
      albSg.addIngressRule(
        ec2.Peer.ipv4(vpc.vpcCidrBlock),
        ec2.Port.tcp(80),
        'Allow from VPC on port 80',
      );

      const alb = new elbv2.ApplicationLoadBalancer(this, 'AuthAlb', {
        loadBalancerName: `nanoclawbot-${stage}-auth-alb`,
        vpc,
        internetFacing: false,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroup: albSg,
      });

      const targetGroup = new elbv2.ApplicationTargetGroup(this, 'AuthTargetGroup', {
        vpc,
        port: 3001,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targets: [service],
        healthCheck: {
          path: '/auth/health',
          interval: cdk.Duration.seconds(30),
          timeout: cdk.Duration.seconds(5),
          healthyThresholdCount: 2,
          unhealthyThresholdCount: 3,
        },
      });

      alb.addListener('AuthHttpListener', {
        port: 80,
        defaultTargetGroups: [targetGroup],
      });

      this.authEndpoint = `http://${alb.loadBalancerDnsName}`;
      this.authJwksUrl = `http://${alb.loadBalancerDnsName}/auth/.well-known/jwks.json`;

      // Dummy Cognito values for type compatibility
      this.userPool = {} as unknown as cognito.IUserPool;
      this.userPoolClient = {} as unknown as cognito.IUserPoolClient;

      // ── Outputs ─────────────────────────────────────────────────────────
      new cdk.CfnOutput(this, 'AuthEndpoint', {
        value: this.authEndpoint,
        exportName: `nanoclawbot-${stage}-auth-endpoint`,
      });

      new cdk.CfnOutput(this, 'AuthJwksUrl', {
        value: this.authJwksUrl,
        exportName: `nanoclawbot-${stage}-auth-jwks-url`,
      });
    } else {
      // ── Cognito User Pool (agentcore mode) ────────────────────────────
      const userPool = new cognito.UserPool(this, 'UserPool', {
        userPoolName: `nanoclawbot-${stage}-users`,
        selfSignUpEnabled: false,
        signInAliases: {
          email: true,
        },
        autoVerify: {
          email: true,
        },
        passwordPolicy: {
          minLength: 8,
          requireUppercase: true,
          requireLowercase: true,
          requireDigits: true,
          requireSymbols: false,
        },
        accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
        removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      });

      const userPoolClient = new cognito.UserPoolClient(this, 'WebClient', {
        userPoolClientName: `nanoclawbot-${stage}-web`,
        userPool,
        authFlows: {
          userPassword: true,
          userSrp: true,
        },
        oAuth: {
          flows: {
            implicitCodeGrant: true,
          },
          callbackUrls: ['http://localhost:5173'],
          logoutUrls: ['http://localhost:5173'],
        },
      });

      this.userPool = userPool;
      this.userPoolClient = userPoolClient;
      this.authEndpoint = '';
      this.authJwksUrl = '';

      // ── Outputs ─────────────────────────────────────────────────────────
      new cdk.CfnOutput(this, 'UserPoolId', {
        value: userPool.userPoolId,
        exportName: `nanoclawbot-${stage}-user-pool-id`,
      });

      new cdk.CfnOutput(this, 'UserPoolClientId', {
        value: userPoolClient.userPoolClientId,
        exportName: `nanoclawbot-${stage}-user-pool-client-id`,
      });
    }
  }
}
