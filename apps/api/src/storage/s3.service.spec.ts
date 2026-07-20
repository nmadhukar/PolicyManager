import { S3Client } from '@aws-sdk/client-s3';
import { S3Service } from './s3.service';

describe('S3Service bootstrap safety', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('applies block-public-access when auto-provisioning the default bucket', async () => {
    const sent: string[] = [];
    jest.spyOn(S3Client.prototype, 'send').mockImplementation(async (command: object) => {
      sent.push(command.constructor.name);
      return {};
    });
    const config = {
      get: (key: string) =>
        ({
          S3_ENDPOINT: 'http://127.0.0.1:9000',
          S3_AUTO_CREATE: 'true',
          S3_BUCKET: 'policymanager-docs',
        })[key],
    };

    await new S3Service(config as never).onModuleInit();

    expect(sent).toEqual(
      expect.arrayContaining([
        'HeadBucketCommand',
        'PutBucketVersioningCommand',
        'PutPublicAccessBlockCommand',
      ]),
    );
  });

  it('rejects default MinIO credentials for non-local private endpoints', () => {
    const config = {
      get: (key: string) =>
        ({
          S3_ENDPOINT: 'http://10.0.0.25:9000',
          S3_BUCKET: 'policymanager-docs',
        })[key],
    };

    expect(() => new S3Service(config as never)).toThrow(/S3_ACCESS_KEY_ID/);
  });

  describe('FINDING-019: bounded request/connection timeout', () => {
    /** NodeHttpHandler resolves its effective config asynchronously via configProvider. */
    interface HandlerLike {
      configProvider: Promise<{ connectionTimeout?: number; requestTimeout?: number }>;
    }

    it('constructs the S3Client with a requestHandler carrying the configured (or default) timeouts', async () => {
      const config = {
        get: (key: string) =>
          ({
            S3_ENDPOINT: 'http://127.0.0.1:9000',
            S3_BUCKET: 'policymanager-docs',
          })[key],
      };

      const svc = new S3Service(config as never);
      // The private client is what every S3 operation (putObject/getObjectBuffer/
      // getPresignedDownloadUrl) actually uses — inspect its resolved config.
      const client = (svc as unknown as { client: { config: { requestHandler: HandlerLike } } }).client;
      const resolved = await client.config.requestHandler.configProvider;

      expect(resolved.connectionTimeout).toBe(5_000);
      expect(resolved.requestTimeout).toBe(30_000);
    });

    it('honours S3_CONNECTION_TIMEOUT_MS / S3_REQUEST_TIMEOUT_MS overrides', async () => {
      const config = {
        get: (key: string) =>
          ({
            S3_ENDPOINT: 'http://127.0.0.1:9000',
            S3_BUCKET: 'policymanager-docs',
            S3_CONNECTION_TIMEOUT_MS: '2000',
            S3_REQUEST_TIMEOUT_MS: '10000',
          })[key],
      };

      const svc = new S3Service(config as never);
      const client = (svc as unknown as { client: { config: { requestHandler: HandlerLike } } }).client;
      const resolved = await client.config.requestHandler.configProvider;

      expect(resolved.connectionTimeout).toBe(2_000);
      expect(resolved.requestTimeout).toBe(10_000);
    });

    it('applies the same bounded requestHandler to the presign client when its endpoint differs', async () => {
      const config = {
        get: (key: string) =>
          ({
            S3_ENDPOINT: 'http://minio:9000',
            S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
            S3_BUCKET: 'policymanager-docs',
            S3_ACCESS_KEY_ID: 'ak',
            S3_SECRET_ACCESS_KEY: 'sk',
          })[key],
      };

      const svc = new S3Service(config as never);
      const presignClient = (
        svc as unknown as { presignClient: { config: { requestHandler: HandlerLike } } }
      ).presignClient;
      const resolved = await presignClient.config.requestHandler.configProvider;

      expect(resolved.connectionTimeout).toBe(5_000);
      expect(resolved.requestTimeout).toBe(30_000);
    });
  });
});
