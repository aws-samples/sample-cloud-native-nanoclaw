#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { FoundationStack } from '../lib/foundation-stack.js';
import { AuthStack } from '../lib/auth-stack.js';
import { AgentStack } from '../lib/agent-stack.js';
import { ControlPlaneStack } from '../lib/control-plane-stack.js';
import { FrontendStack } from '../lib/frontend-stack.js';
import { MonitoringStack } from '../lib/monitoring-stack.js';

const app = new cdk.App();

const stage = process.env.CDK_STAGE ?? 'dev';

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

const foundation = new FoundationStack(app, `NanoClawBot-${stage}-Foundation`, {
  env,
  stage,
});

const auth = new AuthStack(app, `NanoClawBot-${stage}-Auth`, {
  env,
  stage,
});
auth.addDependency(foundation);

const agent = new AgentStack(app, `NanoClawBot-${stage}-Agent`, {
  env,
  stage,
  dataBucket: foundation.dataBucket,
  messageQueue: foundation.messageQueue,
  replyQueue: foundation.replyQueue,
  tables: {
    users: foundation.usersTable,
    bots: foundation.botsTable,
    channels: foundation.channelsTable,
    groups: foundation.groupsTable,
    messages: foundation.messagesTable,
    tasks: foundation.tasksTable,
    sessions: foundation.sessionsTable,
  },
});
agent.addDependency(foundation);

const controlPlane = new ControlPlaneStack(app, `NanoClawBot-${stage}-ControlPlane`, {
  env,
  stage,
  vpc: foundation.vpc,
  dataBucket: foundation.dataBucket,
  ecrRepo: foundation.ecrRepo,
  messageQueue: foundation.messageQueue,
  replyQueue: foundation.replyQueue,
  dlq: foundation.dlq,
  tables: {
    users: foundation.usersTable,
    bots: foundation.botsTable,
    channels: foundation.channelsTable,
    groups: foundation.groupsTable,
    messages: foundation.messagesTable,
    tasks: foundation.tasksTable,
    sessions: foundation.sessionsTable,
    providers: foundation.providersTable,
    skills: foundation.skillsTable,
  },
  userPool: auth.userPool,
  userPoolClient: auth.userPoolClient,
  agentBaseRole: agent.agentBaseRole,
  schedulerRoleArn: agent.schedulerRole.roleArn,
  messageQueueArn: foundation.messageQueue.queueArn,
});
controlPlane.addDependency(foundation);
controlPlane.addDependency(auth);
controlPlane.addDependency(agent);

const frontend = new FrontendStack(app, `NanoClawBot-${stage}-Frontend`, {
  env,
  stage,
  userPool: auth.userPool,
  userPoolClient: auth.userPoolClient,
  alb: controlPlane.alb,
  originVerifySecret: controlPlane.originVerifySecret,
});
frontend.addDependency(auth);
frontend.addDependency(controlPlane);

const monitoring = new MonitoringStack(app, `NanoClawBot-${stage}-Monitoring`, {
  env,
  stage,
  messageQueue: foundation.messageQueue,
  dlq: foundation.dlq,
  cluster: controlPlane.cluster,
  service: controlPlane.service,
  tables: {
    users: foundation.usersTable,
    bots: foundation.botsTable,
    channels: foundation.channelsTable,
    groups: foundation.groupsTable,
    messages: foundation.messagesTable,
    tasks: foundation.tasksTable,
    sessions: foundation.sessionsTable,
  },
});
monitoring.addDependency(foundation);
monitoring.addDependency(controlPlane);

app.synth();
