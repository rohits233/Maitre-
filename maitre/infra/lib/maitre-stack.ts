import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';

export class MaitreStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── VPC: 3 AZs, public + private subnets, 1 NAT Gateway ──────────────────
    const vpc = new ec2.Vpc(this, 'MaitreVpc', {
      maxAzs: 3,
      natGateways: 1,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    // ── Security Groups ───────────────────────────────────────────────────────
    const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc,
      description: 'ALB - inbound HTTP/HTTPS from internet',
      allowAllOutbound: false,
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP');
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS');

    const fargateSg = new ec2.SecurityGroup(this, 'FargateSg', {
      vpc,
      description: 'Fargate tasks - inbound from ALB only',
      allowAllOutbound: true,
    });
    fargateSg.addIngressRule(albSg, ec2.Port.tcp(8080), 'From ALB');
    albSg.addEgressRule(fargateSg, ec2.Port.tcp(8080), 'To Fargate');

    // ── ECR Repository ────────────────────────────────────────────────────────
    const repository = ecr.Repository.fromRepositoryName(this, 'MaitreRepo', 'maitre');

    // ── Twilio credentials (Secrets Manager) ─────────────────────────────────
    const twilioSecret = secretsmanager.Secret.fromSecretNameV2(
      this, 'TwilioSecret', 'maitre/twilio'
    );

    // ── ECS Cluster ───────────────────────────────────────────────────────────
    const cluster = new ecs.Cluster(this, 'MaitreCluster', {
      vpc,
      clusterName: 'maitre',
    });

    // ── CloudWatch Log Group ──────────────────────────────────────────────────
    const logGroup = new logs.LogGroup(this, 'MaitreLogs', {
      logGroupName: '/ecs/maitre',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── Fargate Task Definition ───────────────────────────────────────────────
    const taskDef = new ecs.FargateTaskDefinition(this, 'MaitreTaskDef', {
      cpu: 512,
      memoryLimitMiB: 1024,
    });

    twilioSecret.grantRead(taskDef.taskRole);

    // ── Bedrock permissions for Nova Sonic ─────────────────────────────────────
    taskDef.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModelWithBidirectionalStream', 'bedrock:InvokeModel'],
      resources: [`arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-sonic-v1:0`],
    }));

    // ── DynamoDB permissions ──────────────────────────────────────────────────
    taskDef.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem',
        'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:Scan',
        'dynamodb:BatchGetItem', 'dynamodb:BatchWriteItem',
      ],
      resources: [`arn:aws:dynamodb:us-east-1:${this.account}:table/*`],
    }));

    taskDef.addContainer('maitre', {
      image: ecs.ContainerImage.fromEcrRepository(repository, 'latest'),
      portMappings: [{ containerPort: 8080 }],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'maitre', logGroup }),
      environment: {
        PORT: '8080',
        NODE_ENV: 'production',
        HOST: 'voice.qwiklybuy.com',
        AWS_REGION: 'us-east-1',
        SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:728904422502:secret:maitre/twilio',
        TWILIO_PHONE_NUMBER: '+13186484313',
        RESERVATIONS_TABLE: 'Reservations',
        AVAILABILITY_SLOTS_TABLE: 'AvailabilitySlots',
        LOCATIONS_TABLE: 'Locations',
        VIP_LIST_TABLE: 'VIPList',
        CALL_FLOW_RULES_TABLE: 'CallFlowRules',
        VOICE_PERSONAS_TABLE: 'VoicePersonas',
        CALL_RECORDS_TABLE: 'CallRecords',
        IDEMPOTENCY_KEYS_TABLE: 'IdempotencyKeys',
        FEEDBACK_SURVEYS_TABLE: 'FeedbackSurveys',
        DEFAULT_LOCATION_ID: 'default',
      },
      secrets: {
        TWILIO_ACCOUNT_SID: ecs.Secret.fromSecretsManager(twilioSecret, 'TWILIO_ACCOUNT_SID'),
        TWILIO_AUTH_TOKEN:  ecs.Secret.fromSecretsManager(twilioSecret, 'TWILIO_AUTH_TOKEN'),
      },
      healthCheck: {
        command: ['CMD-SHELL', 'wget -qO- http://localhost:8080/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
      stopTimeout: cdk.Duration.seconds(120),
    });

    // ── Fargate Service ───────────────────────────────────────────────────────
    const service = new ecs.FargateService(this, 'MaitreService', {
      cluster,
      taskDefinition: taskDef,
      serviceName: 'maitre',
      desiredCount: 1,
      minHealthyPercent: 0,
      maxHealthyPercent: 200,
      assignPublicIp: false,
      securityGroups: [fargateSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    // ── ALB (WebSocket-compatible) ────────────────────────────────────────────
    const alb = new elbv2.ApplicationLoadBalancer(this, 'MaitreAlb', {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
      idleTimeout: cdk.Duration.seconds(3600),
    });

    // ── ACM Certificate (voice.qwiklybuy.com) ─────────────────────────────────
    const certificate = acm.Certificate.fromCertificateArn(
      this, 'VoiceCert',
      'arn:aws:acm:us-east-1:728904422502:certificate/cbd6177c-fef5-4a04-a0b1-6496f1b50a04'
    );

    // ── HTTPS listener (port 443) ─────────────────────────────────────────────
    const httpsListener = alb.addListener('HttpsListener', {
      port: 443,
      certificates: [certificate],
      open: true,
    });

    httpsListener.addTargets('MaitreTargets', {
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      loadBalancingAlgorithmType: elbv2.TargetGroupLoadBalancingAlgorithmType.LEAST_OUTSTANDING_REQUESTS,
      deregistrationDelay: cdk.Duration.seconds(120),
      healthCheck: {
        path: '/health',
        interval: cdk.Duration.seconds(30),
        healthyHttpCodes: '200',
      },
    });

    // ── HTTP listener redirects to HTTPS ──────────────────────────────────────
    alb.addListener('HttpListener', {
      port: 80,
      open: true,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true,
      }),
    });

    // ── CodeBuild: builds Docker image from S3 source, pushes to ECR ─────────
    const sourceBucket = s3.Bucket.fromBucketName(
      this, 'SourceBucket', `maitre-source-${this.account}`
    );

    const buildLogGroup = new logs.LogGroup(this, 'CodeBuildLogs', {
      logGroupName: '/codebuild/maitre',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const buildProject = new codebuild.Project(this, 'MaitreDockerBuild', {
      projectName: 'maitre-docker-build',
      description: 'Builds maitre-ts Docker image from S3 and pushes to ECR',
      source: codebuild.Source.s3({
        bucket: sourceBucket,
        path: 'maitre-ts-source.zip',
      }),
      buildSpec: codebuild.BuildSpec.fromSourceFilename('maitre-ts/buildspec.yml'),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        privileged: true,
        computeType: codebuild.ComputeType.SMALL,
      },
      environmentVariables: {
        AWS_DEFAULT_REGION: { value: this.region },
        ECR_REPO_NAME: { value: 'maitre' },
      },
      logging: {
        cloudWatch: { logGroup: buildLogGroup, prefix: 'build' },
      },
    });

    repository.grantPullPush(buildProject);
    sourceBucket.grantRead(buildProject);
    buildProject.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecr:GetAuthorizationToken'],
      resources: ['*'],
    }));

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'WebhookUrl', {
      value: `https://voice.qwiklybuy.com/voice/inbound`,
      description: 'Paste into Twilio as your Voice webhook URL',
    });

    new cdk.CfnOutput(this, 'MediaStreamUrl', {
      value: `wss://voice.qwiklybuy.com/media-stream`,
      description: 'Nova Sonic WebSocket media stream URL',
    });

    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: alb.loadBalancerDnsName,
    });

    new cdk.CfnOutput(this, 'CodeBuildProject', {
      value: buildProject.projectName,
      description: 'Run: aws codebuild start-build --project-name maitre-docker-build',
    });
  }
}
